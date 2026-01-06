import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=1'
});

const CRITICAL_ENDPOINTS: Record<string, string> = {
    // Vamos mirar no WSDL pois ele é um XML grande e garantido
    'PR_NFCe': 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4?wsdl',
};

async function checkRealEndpoint(url: string): Promise<'online' | 'offline' | 'instavel'> {
    const start = Date.now();
    const separator = url.includes('?') ? '&' : '?';
    // Adiciona timestamp para evitar cache
    const targetUrl = `${url}${separator}cb=${Date.now()}`;

    try {
        console.log(`⚡ Testando: ${targetUrl}`);

        const response = await axios.get(targetUrl, {
            httpsAgent,
            timeout: 10000, // 10s de limite
            responseType: 'text', // Força texto para leitura
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', // Tenta se passar pelo Google
                'Cache-Control': 'no-cache'
            },
            validateStatus: (status) => status === 200
        });

        const latency = Date.now() - start;
        const body = response.data || '';

        // --- DEBUG: O QUE A VERCEL ESTÁ RECEBENDO? ---
        // Isso vai aparecer nos logs da Vercel (Runtime Logs)
        console.log(`🔍 RESPOSTA PR (${body.length} bytes): ${body.substring(0, 100)}...`);

        // --- REGRAS DRACONIANAS ---

        // 1. Se for muito curto (menos de 500 chars), não é um WSDL da SEFAZ (que tem +20kb).
        // Páginas de bloqueio costumam ser pequenas.
        if (body.length < 500) {
            console.log(`❌ FALHA: Resposta muito curta (${body.length} bytes). Provável bloqueio.`);
            return 'offline';
        }

        // 2. Se não começar com tag XML, é página HTML de erro.
        if (!body.trim().startsWith('<')) {
            console.log(`❌ FALHA: Não começa com XML.`);
            return 'offline';
        }

        // 3. Se não tiver "wsdl" ou "schema" no texto, não é o que queremos.
        if (!body.includes('wsdl') && !body.includes('schema') && !body.includes('definitions')) {
            console.log(`❌ FALHA: XML inválido (não parece WSDL).`);
            return 'offline';
        }

        console.log(`✅ PR XML/WSDL Válido (${latency}ms)`);

        // Se passou por tudo isso e demorou, é instável
        return latency > 1000 ? 'instavel' : 'online';

    } catch (error: any) {
        console.log(`❌ FALHA CONEXÃO: ${error.code || error.message}`);
        return 'offline';
    }
}

export async function GET() {
    try {
        // --- SCRAPING DO PORTAL NACIONAL (MANTIDO IGUAL) ---
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;
        const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${randomVer}.0.0.0 Safari/537.36`;

        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 15000, maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: { 'User-Agent': userAgent }
        });

        let html = response1.data;
        if (response1.status === 302 || response1.status === 301) {
            const loc = response1.headers.location;
            if (loc) {
                const nextUrl = loc.startsWith('http') ? loc : `https://www.nfe.fazenda.gov.br${loc}`;
                const res2 = await axios.get(nextUrl, {
                    httpsAgent,
                    headers: { 'Cookie': response1.headers['set-cookie']?.join('; '), 'User-Agent': userAgent }
                });
                html = res2.data;
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

            // Lógica de Validação Real
            if (CRITICAL_ENDPOINTS[endpointKey]) {
                const checkTask = checkRealEndpoint(CRITICAL_ENDPOINTS[endpointKey])
                    .then((realStatus) => {
                        // Se falhar no teste real, marca como OFFLINE/INSTAVEL
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

        return NextResponse.json(results, {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
            }
        });

    } catch (error: any) {
        console.error("ERRO:", error.message);
        return NextResponse.json({ error: "Falha técnica" }, { status: 500 });
    }
}