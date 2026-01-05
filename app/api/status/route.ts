import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

// 1. Configuração de TLS para aceitar conexões legadas do governo
const httpsAgent = new https.Agent({
    rejectUnauthorized: false, // Ignora erro de certificado (necessário pois não temos o pfx aqui)
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=1'
});

// 2. LISTA DE ENDPOINTS REAIS (O Segredo do Vizinho)
// Aqui mapeamos as URLs que costumam cair. Começando pelo PR.
const CRITICAL_ENDPOINTS: Record<string, string> = {
    'PR_NFCe': 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4',
    // Futuramente você pode adicionar outros:
    // 'SP_NFe': 'https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
};

// Função que testa a URL real ("Bate na porta")
async function checkRealEndpoint(url: string): Promise<'online' | 'offline' | 'instavel'> {
    const start = Date.now();
    try {
        // Tenta conectar. Esperamos 5 segundos (timeout curto).
        // Se responder 403, 500 ou 200, o servidor está VIVO.
        await axios.get(url, {
            httpsAgent,
            timeout: 5000, // Se demorar mais que 5s, consideramos OFF
            validateStatus: () => true // Aceita qualquer status HTTP como "Sucesso de Conexão"
        });

        const latency = Date.now() - start;
        return latency > 2000 ? 'instavel' : 'online';

    } catch (error: any) {
        // Se der TIMEOUT ou Erro de Conexão, o servidor caiu
        if (error.code === 'ECONNABORTED' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            console.log(`❌ Falha no Endpoint Real (${url}): ${error.code}`);
            return 'offline';
        }
        // Outros erros podem ser apenas falta de certificado, então assumimos online
        return 'online';
    }
}

export async function GET() {
    try {
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;
        const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${randomVer}.0.0.0 Safari/537.36`;

        console.log(`1. Iniciando conexão manual...`);

        // --- BLOCO DE SCRAPING (Mantido para pegar a base de todos os estados) ---
        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 15000, maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: { 'User-Agent': userAgent, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
        });

        let html = response1.data;
        let finalResponse = response1;

        // Lógica de Redirect (Handshake)
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
        // --------------------------------------------------------------------

        const $ = cheerio.load(html);
        const results: any[] = [];
        const promises: Promise<void>[] = []; // Para rodar verificações paralelas

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

            // 1. Salva NFe (Usa o dado do Portal Nacional)
            results.push({ ...baseData, modelo: 'NFe' });

            // 2. Prepara NFCe (Aqui entra a mágica do Vizinho)
            const nfceData = { ...baseData, modelo: 'NFCe' };

            // Se tivermos uma URL específica para esse estado e modelo, vamos testar!
            const endpointKey = `${estado}_NFCe`;

            if (CRITICAL_ENDPOINTS[endpointKey]) {
                // Adiciona na fila de verificação
                const checkPromise = checkRealEndpoint(CRITICAL_ENDPOINTS[endpointKey])
                    .then((realStatus) => {
                        // Se o teste real disse que está OFFLINE ou INSTAVEL,
                        // a gente SOBRESCREVE o que o governo disse.
                        if (realStatus !== 'online') {
                            console.log(`⚠️ DETECTADO: ${estado} NFCe está ${realStatus} no teste real!`);
                            nfceData.autorizacao = realStatus;
                            nfceData.status_servico = realStatus; // Derruba o status geral também
                        }
                    });
                promises.push(checkPromise);
            }

            results.push(nfceData);
        });

        // Espera todos os testes de URL terminarem
        await Promise.all(promises);

        if (results.length === 0) {
            return NextResponse.json({ error: "Layout mudou" }, { status: 502 });
        }

        const { error: dbError } = await supabase.from('sefaz_logs').insert(results);

        if (dbError) console.error("Erro Supabase:", dbError.message);
        else console.log(`Sucesso! ${results.length} registros salvos.`);

        return NextResponse.json(results);

    } catch (error: any) {
        console.error("ERRO CRÍTICO:", error.message);
        return NextResponse.json({ error: "Falha técnica" }, { status: 500 });
    }
}