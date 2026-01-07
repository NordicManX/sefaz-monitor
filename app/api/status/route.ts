import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Agente para tentar burlar verificações simples de TLS antigas
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=1'
});

const PR_URL = 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4?wsdl';

async function checkRealEndpoint(url: string): Promise<{ status: 'online' | 'offline' | 'instavel', msg: string, latency: number }> {
    const start = Date.now();
    // Remover o parâmetro de cache busting na URL WSDL as vezes ajuda
    const targetUrl = url;

    try {
        console.log(`⚡ Testando PR: ${targetUrl}`);

        const response = await axios.get(targetUrl, {
            httpsAgent,
            timeout: 10000, // 10 segundos é suficiente
            responseType: 'text', // Importante para não quebrar parsing
            headers: {
                // User-Agent genérico de navegador para passar pelo WAF
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            },
            // IMPORTANTE: Aceitar qualquer status como sucesso para analisarmos manualmente
            validateStatus: () => true
        });

        const latency = Date.now() - start;
        const code = response.status;

        // LÓGICA CORRIGIDA:
        // 403 = O servidor está lá, mas bloqueou nosso acesso (Falta certificado). Logo, está ONLINE.
        // 500 = O servidor processou e deu erro interno. Logo, está ONLINE.
        // 200 = Sucesso total.

        if (code === 200 || code === 403 || code === 500 || code === 401) {
            // Se a latência for alta, marcamos como instável
            if (latency > 2000) {
                return { status: 'instavel', msg: `Lento: ${latency}ms (Code ${code})`, latency };
            }
            return { status: 'online', msg: `Respondeu com código ${code}`, latency };
        }

        // Se chegou aqui, é um código muito estranho (ex: 404 not found na raiz da API)
        return { status: 'instavel', msg: `Status inesperado: ${code}`, latency };

    } catch (error: any) {
        // AQUI SIM É OFFLINE (Erro de rede, DNS, Timeout)
        const errorMsg = error.message || "Erro desconhecido";
        console.error(`Falha PR: ${errorMsg}`);

        // Verifica se é erro de certificado (comum na SEFAZ), as vezes consideramos online se for só erro de SSL
        if (errorMsg.includes('socket hang up') || errorMsg.includes('ECONNRESET')) {
            // As vezes o firewall derruba a conexão TCP. Pode ser considerado instável ou offline.
            return { status: 'instavel', msg: 'Conexão derrubada pelo servidor', latency: 0 };
        }

        return { status: 'offline', msg: errorMsg, latency: 0 };
    }
}

export async function GET() {
    try {
        // 1. Teste Real (Agora com lógica corrigida)
        const prCheck = await checkRealEndpoint(PR_URL);

        // 2. Scraping do Portal Nacional (Mantive igual)
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;

        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 15000, maxRedirects: 5, // Aumentei redirects
            validateStatus: (s) => s >= 200 && s < 400,
            headers: {
                'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/${randomVer}.0.0.0 Safari/537.36`
            }
        });

        const $ = cheerio.load(response1.data);
        const results: any[] = [];

        $('table.tabelaListagemDados tr').each((i, row) => {
            const cols = $(row).find('td');
            if (cols.length < 6) return;
            const estado = cols.eq(0).text().trim();
            if (!estado || estado.length !== 2) return;

            const getStatusColor = (tdIndex: number) => {
                const img = cols.eq(tdIndex).find('img').attr('src');
                if (!img) return 'unknown';
                if (img.includes('bola_verde')) return 'online';
                if (img.includes('bola_amarela')) return 'instavel';
                if (img.includes('bola_vermelha')) return 'offline';
                return 'unknown';
            };

            // Dados base do Portal Nacional
            const baseData = {
                estado,
                autorizacao: getStatusColor(1),
                retorno_autorizacao: getStatusColor(2),
                inutilizacao: getStatusColor(3),
                consulta: getStatusColor(4),
                status_servico: getStatusColor(5),
                details: null,
                latency: 0
            };

            // Se for PR, sobrescrevemos com nosso teste REAL
            if (estado === 'PR') {
                const nfeData = { ...baseData, modelo: 'NFe' };
                const nfceData = { ...baseData, modelo: 'NFCe' };

                // Aplica o resultado do teste real nas colunas principais
                nfceData.autorizacao = prCheck.status;
                nfceData.status_servico = prCheck.status;
                nfceData.latency = prCheck.latency;

                if (prCheck.status !== 'online') {
                    // @ts-ignore
                    nfceData.details = prCheck.msg;
                    // Se o autorizador tá fora, o resto provavelmente também está (simulação)
                    if (prCheck.status === 'offline') {
                        nfceData.retorno_autorizacao = 'offline';
                    }
                }

                results.push(nfeData);
                // Opcional: Empurrar NFe separado se quiser
                // results.push(nfeData); 
            } else {
                // Outros estados usa só o portal
                results.push({ ...baseData, modelo: 'NFe' });
                results.push({ ...baseData, modelo: 'NFCe' });
            }
        });

        // 3. Salvar no Supabase (CUIDADO COM O VOLUME DE DADOS SE FIZER POLLING RÁPIDO)
        // Sugestão: Só salvar se mudar de status ou a cada X minutos.
        await supabase.from('sefaz_logs').insert(results);

        return NextResponse.json(results, {
            headers: { 'Cache-Control': 'no-store, no-cache' }
        });

    } catch (error: any) {
        console.error("ERRO GERAL:", error.message);
        return NextResponse.json({ error: "Falha técnica", details: error.message }, { status: 500 });
    }
}