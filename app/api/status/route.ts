import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

// 1. Agente HTTPS para aceitar criptografia legada do governo
// Isso é essencial para não dar erro de SSL antes mesmo de conectar
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=1'
});

// 2. LISTA DE ENDPOINTS CRÍTICOS (A "Lista Negra" de quem costuma cair)
// Mapeamos a URL real de autorização da NFCe do PR.
const CRITICAL_ENDPOINTS: Record<string, string> = {
    'PR_NFCe': 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4',
};

// Função que faz o "Ping" na URL real
async function checkRealEndpoint(url: string): Promise<'online' | 'offline' | 'instavel'> {
    const start = Date.now();
    try {
        console.log(`⚡ Testando conexão real: ${url}`);

        // Tenta conectar com Timeout curto (5 segundos)
        // O vizinho marca "Timeout > 30s" como erro, mas nós seremos mais rápidos: 5s já é erro.
        await axios.get(url, {
            httpsAgent,
            timeout: 5000,
            validateStatus: () => true // Aceita 500 ou 403 como "Servidor Vivo"
        });

        const latency = Date.now() - start;
        console.log(`✅ Sucesso PR (${latency}ms)`);

        // Se demorou mais de 2s, é instável (amarelo)
        return latency > 2000 ? 'instavel' : 'online';

    } catch (error: any) {
        // Se cair aqui, é porque o servidor nem respondeu (Timeout ou Queda Total)
        console.log(`❌ FALHA REAL NO PR: ${error.code || error.message}`);
        return 'offline'; // Retorna VERMELHO
    }
}

export async function GET() {
    try {
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        // User Agent rotativo para não sermos bloqueados pelo portal nacional
        const randomVer = Math.floor(Math.random() * 20) + 110;
        const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${randomVer}.0.0.0 Safari/537.36`;

        console.log(`1. Iniciando Scraping Geral...`);

        // --- ETAPA 1: SCRAPING DO PORTAL NACIONAL (Visão Geral) ---
        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 15000, maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: { 'User-Agent': userAgent }
        });

        let html = response1.data;
        let finalResponse = response1;

        // Tratamento de Redirect (Handshake)
        if (response1.status === 302 || response1.status === 301) {
            const cookies = response1.headers['set-cookie'];
            const redirectLocation = response1.headers.location;
            if (redirectLocation) {
                const nextUrl = redirectLocation.startsWith('http') ? redirectLocation : `https://www.nfe.fazenda.gov.br${redirectLocation}`;
                finalResponse = await axios.get(nextUrl, {
                    httpsAgent,
                    headers: { 'Cookie': cookies ? cookies.join('; ') : '', 'User-Agent': userAgent }
                });
                html = finalResponse.data;
            }
        }

        const $ = cheerio.load(html);
        const results: any[] = [];
        const verificationQueue: Promise<void>[] = []; // Fila de testes reais

        // Processa a tabela
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

            const baseData = {
                estado,
                autorizacao: getStatusColor(1),
                retorno_autorizacao: getStatusColor(2),
                inutilizacao: getStatusColor(3),
                consulta: getStatusColor(4),
                status_servico: getStatusColor(5),
            };

            // 1. NFe (Usa o dado oficial do portal)
            results.push({ ...baseData, modelo: 'NFe' });

            // 2. NFCe (Aqui aplicamos a inteligência do Vizinho)
            const nfceData = { ...baseData, modelo: 'NFCe' };

            // Verifica se este estado tem um endpoint crítico mapeado (ex: PR)
            const endpointKey = `${estado}_NFCe`;

            if (CRITICAL_ENDPOINTS[endpointKey]) {
                // Adiciona o teste na fila para rodar em paralelo
                const checkTask = checkRealEndpoint(CRITICAL_ENDPOINTS[endpointKey])
                    .then((realStatus) => {
                        // Se o status real for diferente de 'online', SOBRESCREVEMOS o portal
                        if (realStatus !== 'online') {
                            console.log(`⚠️ OVERRIDE: ${estado} NFCe marcado como ${realStatus}`);
                            nfceData.autorizacao = realStatus;
                            nfceData.status_servico = realStatus; // Derruba o serviço todo

                            // Se estiver offline, marca retorno também
                            if (realStatus === 'offline') {
                                nfceData.retorno_autorizacao = 'offline';
                            }
                        }
                    });
                verificationQueue.push(checkTask);
            }

            results.push(nfceData);
        });

        // Espera o teste do PR terminar antes de salvar
        await Promise.all(verificationQueue);

        // Validação final
        if (results.length === 0) {
            return NextResponse.json({ error: "Falha no Layout SEFAZ" }, { status: 502 });
        }

        // Salva no banco
        const { error: dbError } = await supabase.from('sefaz_logs').insert(results);

        if (dbError) {
            console.error("Erro Supabase:", dbError.message);
        } else {
            console.log(`Sucesso! ${results.length} registros atualizados.`);
        }

        return NextResponse.json(results);

    } catch (error: any) {
        console.error("ERRO CRÍTICO:", error.message);
        return NextResponse.json({ error: "Falha técnica no servidor" }, { status: 500 });
    }
}