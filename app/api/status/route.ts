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

// Variável global para guardar o debug da última execução
let debugLog = "";

async function checkRealEndpoint(url: string): Promise<{ status: 'online' | 'offline' | 'instavel', log: string }> {
    const start = Date.now();
    const targetUrl = `${url}&cb=${Date.now()}`;

    try {
        console.log(`[DEBUG] Iniciando teste forçado em: ${targetUrl}`);

        const response = await axios.get(targetUrl, {
            httpsAgent,
            timeout: 10000,
            responseType: 'text',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' },
            validateStatus: (s) => true // Aceita tudo para lermos o corpo
        });

        const latency = Date.now() - start;
        const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        const code = response.status;

        const preview = body.substring(0, 200).replace(/\n/g, ' '); // Pega o começo do texto
        const logMsg = `HTTP ${code} (${latency}ms) - Inicio: "${preview}..."`;

        console.log(`[DEBUG_RESULT] ${logMsg}`);

        // --- REGRAS DE BLOQUEIO ---

        // 1. Se não for 200 OK -> Offline
        if (code !== 200) return { status: 'offline', log: `Status ${code} (Não é 200). ${logMsg}` };

        // 2. Se for HTML -> Offline (Bloqueio)
        if (body.includes('<html') || body.includes('<!DOCTYPE')) {
            return { status: 'offline', log: `DETECTADO HTML (BLOQUEIO). ${logMsg}` };
        }

        // 3. Se for muito curto -> Offline
        if (body.length < 500) {
            return { status: 'offline', log: `CORPO MUITO CURTO (${body.length}b). ${logMsg}` };
        }

        // 4. Se não tiver XML/WSDL -> Offline
        if (!body.includes('wsdl') && !body.includes('schema')) {
            return { status: 'offline', log: `XML INVÁLIDO. ${logMsg}` };
        }

        return { status: latency > 800 ? 'instavel' : 'online', log: `SUCESSO XML. ${logMsg}` };

    } catch (error: any) {
        return { status: 'offline', log: `ERRO AXIOS: ${error.message}` };
    }
}

export async function GET() {
    try {
        // --- 1. EXECUTA O TESTE DO PARANÁ PRIMEIRO E GUARDA O LOG ---
        const prCheck = await checkRealEndpoint(PR_URL);
        console.log("DIAGNOSTICO PR:", prCheck.log);

        // --- 2. LOGICA PADRÃO (PORTAL NACIONAL) ---
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
            const estado = cols.eq(0).text().trim(); // PR
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

            // APLICA O DIAGNOSTICO NO PR
            const nfceData = { ...baseData, modelo: 'NFCe' };

            if (estado === 'PR') {
                // Se o teste real deu erro, SOBRESCREVE
                if (prCheck.status !== 'online') {
                    nfceData.autorizacao = prCheck.status;
                    nfceData.status_servico = prCheck.status;
                    if (prCheck.status === 'offline') {
                        nfceData.retorno_autorizacao = 'offline';
                        nfceData.consulta = 'offline';
                    }
                }
            }
            results.push(nfceData);
        });

        if (results.length === 0) return NextResponse.json({ error: "Falha Layout" }, { status: 502 });

        await supabase.from('sefaz_logs').insert(results);

        // RETORNA O LOG DE DEBUG JUNTO COM O JSON PARA VOCÊ LER NO NAVEGADOR
        return NextResponse.json({
            data: results,
            DEBUG_PR: prCheck.log  // <--- OLHE AQUI NO NAVEGADOR
        }, {
            headers: { 'Cache-Control': 'no-store, no-cache' }
        });

    } catch (error: any) {
        return NextResponse.json({ error: "Falha técnica", details: error.message }, { status: 500 });
    }
}