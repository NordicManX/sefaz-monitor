import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic'; // <--- OBRIGA O NEXT A NÃO FAZER CACHE

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=1'
});

const CRITICAL_ENDPOINTS: Record<string, string> = {
    'PR_NFCe': 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4',
};

async function checkRealEndpoint(url: string): Promise<'online' | 'offline' | 'instavel'> {
    const start = Date.now();
    try {
        // --- TRUQUE DO CACHE BUSTER ---
        // Adiciona ?t=123456 na URL para evitar que o WAF/CDN entregue versão velha
        const targetUrl = `${url}?t=${Date.now()}`;

        console.log(`⚡ Testando (Sem Cache): ${targetUrl}`);

        const response = await axios.get(targetUrl, {
            httpsAgent,
            timeout: 15000, // 15s de tolerância
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            validateStatus: (status) => {
                // Aceita apenas 200 e 405. 
                // Recusa 500, 503, 403.
                return status === 200 || status === 405;
            }
        });

        const latency = Date.now() - start;
        console.log(`✅ PR Respondeu em ${latency}ms`);

        // Se demorar mais de 800ms, é INSTÁVEL (Laranja)
        return latency > 800 ? 'instavel' : 'online';

    } catch (error: any) {
        console.log(`❌ FALHA REAL: ${error.code || error.response?.status}`);
        return 'offline';
    }
}

export async function GET() {
    try {
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;
        const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${randomVer}.0.0.0 Safari/537.36`;

        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 15000, maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: {
                'User-Agent': userAgent,
                'Cache-Control': 'no-cache' // Header anti-cache
            }
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

            // ... Lógica de extração das cores mantida ...
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
                        if (realStatus !== 'online') {
                            console.log(`⚠️ OVERRIDE: ${estado} NFCe -> ${realStatus}`);
                            nfceData.autorizacao = realStatus;
                            nfceData.status_servico = realStatus;
                            if (realStatus === 'offline') {
                                nfceData.retorno_autorizacao = 'offline';
                                nfceData.consulta = 'offline';
                            }
                        }
                    });
                verificationQueue.push(checkTask);
            }
            results.push(nfceData);
        });

        await Promise.all(verificationQueue);

        if (results.length === 0) return NextResponse.json({ error: "Falha Layout" }, { status: 502 });

        await supabase.from('sefaz_logs').insert(results);

        // Retorna com headers que proíbem cache no navegador
        return NextResponse.json(results, {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
            }
        });

    } catch (error: any) {
        console.error("ERRO:", error.message);
        return NextResponse.json({ error: "Falha técnica" }, { status: 500 });
    }
}