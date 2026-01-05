import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

// 1. FORÇA O NEXT.JS A NÃO FAZER CACHE (ESSENCIAL PARA VERCEL)
export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

    // 2. TÉCNICA DE CACHE BUSTING (ADICIONA NÚMERO ALEATÓRIO NA URL)
    // Isso força a SEFAZ e a Vercel a tratarem como uma requisição nova
    const targetUrl = `${url}?cache_buster=${Date.now()}`;

    try {
        console.log(`⚡ Testando (Realtime): ${targetUrl}`);

        const response = await axios.get(targetUrl, {
            httpsAgent,
            timeout: 15000, // 15 segundos (igual ao log de timeout do vizinho)
            headers: {
                // Headers para gritar "NÃO QUERO CACHE!"
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            validateStatus: (status) => {
                // SÓ ACEITA SUCESSO. 
                // Se der 500 (Erro 999), 502, 503 ou 403, joga pro catch.
                return status === 200 || status === 405;
            }
        });

        const latency = Date.now() - start;
        console.log(`✅ PR Respondeu em ${latency}ms - Status: ${response.status}`);

        // Se demorou mais de 800ms, já marca como instável (Laranja)
        return latency > 800 ? 'instavel' : 'online';

    } catch (error: any) {
        // --- ANÁLISE DOS ERROS DO VIZINHO ---
        const code = error.code;
        const status = error.response?.status;

        console.log(`❌ FALHA REAL: ${code || status} - ${error.message}`);

        // Mapeamento dos erros que você mandou:
        // "Operation timed out" -> ECONNABORTED
        // "Connection could not be established" -> ECONNREFUSED / ECONNRESET
        // "999 Erro nao catalogado" -> Status 500, 502, 503

        if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'offline'; // Vermelho (Timeout)
        if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'offline'; // Vermelho (Falha Conexão)
        if (status >= 500) return 'offline'; // Vermelho (Erro Interno 999)
        if (status === 403) return 'offline'; // Vermelho (Bloqueio WAF)

        return 'offline';
    }
}

export async function GET() {
    try {
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        // User Agent aleatório para evitar bloqueio do portal nacional
        const randomVer = Math.floor(Math.random() * 20) + 110;
        const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${randomVer}.0.0.0 Safari/537.36`;

        // Busca Portal Nacional (Visão Macro)
        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 15000, maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: { 'User-Agent': userAgent, 'Cache-Control': 'no-cache' }
        });

        let html = response1.data;
        // Lógica de Redirect mantida...
        if (response1.status === 302 || response1.status === 301) {
            const redirectLocation = response1.headers.location;
            if (redirectLocation) {
                const nextUrl = redirectLocation.startsWith('http') ? redirectLocation : `https://www.nfe.fazenda.gov.br${redirectLocation}`;
                const finalResponse = await axios.get(nextUrl, {
                    httpsAgent,
                    headers: { 'Cookie': response1.headers['set-cookie']?.join('; '), 'User-Agent': userAgent }
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

            // Se tiver endpoint crítico mapeado, faz o teste REAL
            if (CRITICAL_ENDPOINTS[endpointKey]) {
                const checkTask = checkRealEndpoint(CRITICAL_ENDPOINTS[endpointKey])
                    .then((realStatus) => {
                        // Se não for 'online' perfeito, sobrescreve o Portal Nacional
                        if (realStatus !== 'online') {
                            console.log(`⚠️ OVERRIDE: ${estado} NFCe -> ${realStatus}`);
                            nfceData.autorizacao = realStatus;
                            nfceData.status_servico = realStatus;

                            // Se caiu autorização, derruba retorno e consulta também
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

        // Retorna com headers anti-cache para o navegador também
        return NextResponse.json(results, {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
            }
        });

    } catch (error: any) {
        console.error("ERRO GERAL:", error.message);
        return NextResponse.json({ error: "Falha técnica" }, { status: 500 });
    }
}