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

// URL alvo (WSDL do PR)
const PR_URL = 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4?wsdl';

async function checkRealEndpoint(url: string): Promise<'online' | 'offline' | 'instavel'> {
    const start = Date.now();
    const targetUrl = `${url}&cb=${Date.now()}`;

    try {
        console.log(`⚡ Testando PR: ${targetUrl}`);

        const response = await axios.get(targetUrl, {
            httpsAgent,
            timeout: 10000, // 10s timeout
            responseType: 'text',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Monitor/1.0)',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            },
            validateStatus: (s) => true
        });

        const latency = Date.now() - start;
        const body = typeof response.data === 'string' ? response.data : '';
        const code = response.status;


        if (code !== 200) {
            console.log(`❌ FALHA PR: Status ${code}`);
            return 'offline';
        }

        if (body.includes('<html') || body.includes('<!DOCTYPE')) {
            console.log(`❌ FALHA PR: HTML Detectado (Bloqueio)`);
            return 'offline';
        }

        if (body.length < 500) {
            console.log(`❌ FALHA PR: Resposta muito curta (${body.length}b)`);
            return 'offline';
        }

        console.log(`✅ SUCESSO PR: XML Válido (${latency}ms)`);
        return latency > 1000 ? 'instavel' : 'online';

    } catch (error: any) {
        console.log(`❌ ERRO CONEXÃO PR: ${error.message}`);

        return 'offline';
    }
}

export async function GET() {
    try {
        // 1. Executa o teste real do Paraná
        const prStatus = await checkRealEndpoint(PR_URL);

        // 2. Scraping do Portal Nacional (Base)
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
                const res2 = await axios.get(nextUrl, { httpsAgent, headers: { 'Cookie': response1.headers['set-cookie']?.join('; '), 'User-Agent': userAgent } });
                html = res2.data;
            }
        }

        const $ = cheerio.load(html);
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

            if (estado === 'PR') {

                if (prStatus !== 'online') {
                    nfceData.autorizacao = prStatus;
                    nfceData.status_servico = prStatus;

                    if (prStatus === 'offline') {
                        nfceData.retorno_autorizacao = 'offline';
                        nfceData.consulta = 'offline';
                    }
                }
            }
            results.push(nfceData);
        });

        if (results.length === 0) return NextResponse.json({ error: "Falha Layout" }, { status: 502 });

        // Salva no banco
        await supabase.from('sefaz_logs').insert(results);

        // Retorna JSON limpo
        return NextResponse.json(results, {
            headers: { 'Cache-Control': 'no-store, no-cache' }
        });

    } catch (error: any) {
        console.error("ERRO GERAL:", error.message);
        return NextResponse.json({ error: "Falha técnica" }, { status: 500 });
    }
}