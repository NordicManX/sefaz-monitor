import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

// 1. FORÇA O NEXT.JS A NÃO FAZER CACHE
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
    const targetUrl = `${url}?cb=${Date.now()}`; // Cache Buster

    try {
        console.log(`⚡ Testando (Content Check): ${targetUrl}`);

        const response = await axios.get(targetUrl, {
            httpsAgent,
            timeout: 15000,
            responseType: 'text', // Força receber como texto para ler o corpo
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'User-Agent': 'Mozilla/5.0' // Tenta se passar por browser
            },
            validateStatus: (status) => status === 200 || status === 405
        });

        const latency = Date.now() - start;
        const body = response.data || '';

        // --- AQUI ESTÁ A MÁGICA: DETECTOR DE PÁGINA DE ERRO DISFARÇADA ---
        // Se a resposta tiver tags HTML de página comum, é bloqueio/erro disfarçado de 200.
        // O serviço real da SEFAZ retorna XML (SOAP) ou vazio, nunca uma página HTML completa.
        if (typeof body === 'string' && (body.includes('<!DOCTYPE html>') || body.includes('<html') || body.includes('<body'))) {
            console.log(`❌ FALHA: Recebido HTML (Bloqueio WAF) em vez de XML.`);
            return 'offline';
        }

        console.log(`✅ PR Respondeu em ${latency}ms (Conteúdo Válido)`);
        return latency > 800 ? 'instavel' : 'online';

    } catch (error: any) {
        // Log detalhado para debug na Vercel
        const code = error.code;
        const msg = error.message;
        console.log(`❌ FALHA REAL: ${code} - ${msg}`);

        // Mapeamento dos erros do Vizinho para o nosso
        if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'offline';
        if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'offline';

        return 'offline';
    }
}

export async function GET() {
    try {
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;
        const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${randomVer}.0.0.0 Safari/537.36`;

        // Busca Portal Nacional (Mantido igual)
        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 15000, maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: { 'User-Agent': userAgent, 'Cache-Control': 'no-cache' }
        });

        let html = response1.data;
        // Tratamento de Redirect do Portal Nacional...
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

            // Lógica de Override
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