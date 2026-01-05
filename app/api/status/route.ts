import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

// 1. Agente HTTPS (Mantido)
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=1'
});

// 2. Endpoints Críticos
const CRITICAL_ENDPOINTS: Record<string, string> = {
    'PR_NFCe': 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4',
};

// --- AJUSTE DE SENSIBILIDADE AQUI ---
async function checkRealEndpoint(url: string): Promise<'online' | 'offline' | 'instavel'> {
    const start = Date.now();
    try {
        console.log(`⚡ Testando conexão real: ${url}`);

        // Timeout aumentado para 15s (para pegar lentidão extrema sem dar erro de cara)
        const response = await axios.get(url, {
            httpsAgent,
            timeout: 15000, // Aumentei de 5000 para 15000
            validateStatus: (status) => {
                // 403 = WAF/Bloqueio -> Offline
                // 200, 405, 500 -> Servidor respondeu (Online)
                return status === 200 || status === 405 || status === 500;
            }
        });

        const latency = Date.now() - start;
        console.log(`✅ Sucesso PR (${latency}ms) - Status: ${response.status}`);

        // REGRA MAIS RIGOROSA:
        // Antes era > 2000ms. Agora > 800ms já considera "Instável" (Laranja).
        // Isso vai fazer seu monitor "reclamar" mais cedo, igual ao do vizinho.
        return latency > 800 ? 'instavel' : 'online';

    } catch (error: any) {
        const status = error.response?.status;
        const code = error.code;

        console.log(`❌ FALHA REAL NO PR: ${code || status}`);

        if (status === 403 || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
            return 'offline';
        }

        return 'offline';
    }
}

export async function GET() {
    try {
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;
        const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${randomVer}.0.0.0 Safari/537.36`;

        console.log(`1. Iniciando Scraping Geral...`);

        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 15000, maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: { 'User-Agent': userAgent }
        });

        let html = response1.data;
        let finalResponse = response1;

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
        const verificationQueue: Promise<void>[] = [];

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

            results.push({ ...baseData, modelo: 'NFe' });

            const nfceData = { ...baseData, modelo: 'NFCe' };
            const endpointKey = `${estado}_NFCe`;

            if (CRITICAL_ENDPOINTS[endpointKey]) {
                const checkTask = checkRealEndpoint(CRITICAL_ENDPOINTS[endpointKey])
                    .then((realStatus) => {
                        // AGORA SOBRESCREVEMOS SEMPRE QUE NÃO FOR 'ONLINE'
                        // E como baixamos a régua para 800ms, vai dar 'instavel' muito mais fácil.
                        if (realStatus !== 'online') {
                            console.log(`⚠️ OVERRIDE: ${estado} NFCe marcado como ${realStatus}`);
                            nfceData.autorizacao = realStatus;
                            nfceData.status_servico = realStatus;
                            if (realStatus === 'offline') {
                                nfceData.retorno_autorizacao = 'offline';
                            }
                        }
                    });
                verificationQueue.push(checkTask);
            }

            results.push(nfceData);
        });

        await Promise.all(verificationQueue);

        if (results.length === 0) {
            return NextResponse.json({ error: "Falha no Layout SEFAZ" }, { status: 502 });
        }

        const { error: dbError } = await supabase.from('sefaz_logs').insert(results);

        if (dbError) { console.error("Erro Supabase:", dbError.message); }
        else { console.log(`Sucesso! ${results.length} registros atualizados.`); }

        return NextResponse.json(results);

    } catch (error: any) {
        console.error("ERRO CRÍTICO:", error.message);
        return NextResponse.json({ error: "Falha técnica no servidor" }, { status: 500 });
    }
}