import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

// 1. Agente HTTPS
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=1'
});

// 2. Endpoints Críticos (PR NFCe)
const CRITICAL_ENDPOINTS: Record<string, string> = {
    'PR_NFCe': 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4',
};

// --- CHECK RIGOROSO ---
async function checkRealEndpoint(url: string): Promise<'online' | 'offline' | 'instavel'> {
    const start = Date.now();
    try {
        console.log(`⚡ Testando conexão real (Rigoroso): ${url}`);

        // Timeout de 10s
        const response = await axios.get(url, {
            httpsAgent,
            timeout: 10000,
            validateStatus: (status) => {
                // AQUI ESTÁ A MUDANÇA:
                // Aceitamos APENAS 200 (Página OK) ou 405 (SOAP Get).
                // REJEITAMOS 500 (Erro Interno), 503 (Indisponível), 403 (Bloqueio).
                // Se não for 200 ou 405, o Axios vai jogar pro catch (Offline).
                return status === 200 || status === 405;
            }
        });

        const latency = Date.now() - start;
        console.log(`✅ Sucesso PR (${latency}ms) - Status: ${response.status}`);

        // Se a latência for maior que 800ms, já marcamos como instável
        return latency > 800 ? 'instavel' : 'online';

    } catch (error: any) {
        const status = error.response?.status;
        const code = error.code;

        console.log(`❌ FALHA REAL NO PR: Status ${status} | Code ${code}`);

        // Qualquer erro de conexão, timeout, ou status 500/403/503 vira OFFLINE
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
                        // Se o teste rigoroso falhar, derruba o status visualmente
                        if (realStatus !== 'online') {
                            console.log(`⚠️ OVERRIDE: ${estado} NFCe marcado como ${realStatus}`);
                            nfceData.autorizacao = realStatus;
                            nfceData.status_servico = realStatus;

                            // Se for offline, derruba tudo
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