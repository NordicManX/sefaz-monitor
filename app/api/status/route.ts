import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// CONFIGURAÇÃO "NUCLEAR" PARA IGNORAR ERROS DE SSL DA SEFAZ
// Necessário porque a Vercel não tem o certificado digital instalado, 
// então precisamos aceitar que a SEFAZ feche a conexão na nossa cara.
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    ciphers: 'ALL@SECLEVEL=0',
    minVersion: 'TLSv1',
    keepAlive: false
});

// URL EXCLUSIVA DA NFC-e DO PARANÁ
const PR_URL = 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4?wsdl';

async function checkRealEndpoint(url: string): Promise<{ status: 'online' | 'offline' | 'instavel', msg: string, latency: number }> {
    const start = Date.now();

    try {
        const response = await axios.get(url, {
            httpsAgent,
            timeout: 5000, // 5 segundos de tolerância
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Connection': 'close' // Evita reutilização de socket quebrado
            },
            validateStatus: () => true // Aceita 403, 500, etc. como resposta válida
        });

        // Se respondeu HTTP (mesmo 403 ou 500), está ONLINE
        return { status: 'online', msg: `OK (HTTP ${response.status})`, latency: Date.now() - start };

    } catch (error: any) {
        const latency = Date.now() - start;
        const msg = (error.message || '').toLowerCase();
        const code = error.code || '';

        // console.log(`🔍 DEBUG PR NFCe: ${code} - ${msg}`);

        // --- LISTA DE ERROS QUE SIGNIFICAM "ONLINE" ---

        // 1. EPROTO / bad certificate: Servidor respondeu exigindo certificado -> ONLINE
        if (code === 'EPROTO' || msg.includes('certificate')) {
            return { status: 'online', msg: 'Online (Protegido)', latency };
        }

        // 2. socket hang up / ECONNRESET: Firewall da SEFAZ derrubou ativamente -> ONLINE
        if (code === 'ECONNRESET' || msg.includes('socket hang up') || msg.includes('socket disconnected')) {
            return { status: 'online', msg: 'Online (Firewall/TLS Ativo)', latency };
        }

        // 3. Erros de Handshake SSL -> ONLINE
        if (msg.includes('ssl routines') || msg.includes('handshake failure')) {
            return { status: 'online', msg: 'Online (SSL Handshake)', latency };
        }

        // --- SÓ É OFFLINE SE O SERVIDOR SUMIR DO MAPA ---

        if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
            return { status: 'offline', msg: 'Timeout (Servidor não responde)', latency: 0 };
        }

        if (code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
            return { status: 'offline', msg: 'DNS/Host inacessível', latency: 0 };
        }

        // Erro desconhecido assume offline
        return { status: 'offline', msg: `Erro: ${code || msg}`, latency: 0 };
    }
}

export async function GET() {
    try {
        // 1. Executa o teste REAL na URL da NFCe PR
        const prCheck = await checkRealEndpoint(PR_URL);

        // 2. Tenta buscar dados do Portal Nacional (Crawler) para preencher outros estados
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;
        let crawlerFailed = false;
        let response1;

        try {
            response1 = await axios.get(targetUrl, {
                httpsAgent, timeout: 8000,
                validateStatus: () => true,
                headers: { 'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/${randomVer}.0.0.0 Safari/537.36` }
            });
        } catch (e) {
            crawlerFailed = true;
        }

        const results: any[] = [];

        if (!crawlerFailed && response1?.data) {
            const $ = cheerio.load(response1.data);

            $('table.tabelaListagemDados tr').each((i, row) => {
                const cols = $(row).find('td');
                if (cols.length < 6) return;
                const estado = cols.eq(0).text().trim();
                if (!estado) return;

                const getStatusColor = (idx: number) => {
                    const src = cols.eq(idx).find('img').attr('src') || '';
                    if (src.includes('verde')) return 'online';
                    if (src.includes('amarela')) return 'instavel';
                    if (src.includes('vermelha')) return 'offline';
                    return 'online';
                };

                const baseStatus = {
                    estado,
                    autorizacao: getStatusColor(1),
                    retorno_autorizacao: getStatusColor(2),
                    inutilizacao: getStatusColor(3),
                    consulta: getStatusColor(4),
                    status_servico: getStatusColor(5),
                    details: null,
                    latency: 0
                };

                if (estado === 'PR') {
                    // --- AQUI APLICAMOS A LÓGICA DA NFCe DO PR ---
                    const nfceData = { ...baseStatus, modelo: 'NFCe' };
                    const nfeData = { ...baseStatus, modelo: 'NFe' }; // NFe mantemos o do portal ou duplicamos

                    // Sobrescreve com o teste REAL
                    // @ts-ignore
                    nfceData.autorizacao = prCheck.status;
                    // @ts-ignore
                    nfceData.status_servico = prCheck.status;
                    nfceData.latency = prCheck.latency;

                    if (prCheck.status === 'offline') {
                        // Se caiu a autorização, marca tudo como offline
                        // @ts-ignore
                        nfceData.retorno_autorizacao = 'offline';
                        // @ts-ignore
                        nfceData.consulta = 'offline';
                        // @ts-ignore
                        nfceData.details = prCheck.msg;
                    } else {
                        // Se está online (mesmo com erro de certificado), força verde no resto
                        // @ts-ignore
                        nfceData.retorno_autorizacao = 'online';
                        // @ts-ignore
                        nfceData.consulta = 'online';
                    }

                    results.push(nfceData);
                    results.push(nfeData);
                } else {
                    results.push({ ...baseStatus, modelo: 'NFe' });
                    results.push({ ...baseStatus, modelo: 'NFCe' });
                }
            });
        }

        // FALLBACK: Se o crawler falhou ou não retornou nada, retorna pelo menos o PR manual
        if (results.length === 0) {
            return NextResponse.json([{
                estado: 'PR',
                modelo: 'NFCe',
                autorizacao: prCheck.status,
                status_servico: prCheck.status,
                retorno_autorizacao: prCheck.status === 'offline' ? 'offline' : 'online',
                inutilizacao: 'online', // Inutilização raramente cai
                consulta: prCheck.status === 'offline' ? 'offline' : 'online',
                latency: prCheck.latency,
                details: prCheck.msg,
                created_at: new Date().toISOString()
            }], { headers: { 'Cache-Control': 'no-store, no-cache' } });
        }

        // Salvar logs no Supabase (Opcional - Filtrado para PR para economizar banco)
        try {
            const prLogs = results.filter(r => r.estado === 'PR');
            if (prLogs.length > 0) {
                await supabase.from('sefaz_logs').insert(prLogs);
            }
        } catch (err) { console.error('Erro Supabase:', err); }

        return NextResponse.json(results, {
            headers: { 'Cache-Control': 'no-store, no-cache' }
        });

    } catch (error: any) {
        console.error("CRITICAL API ERROR:", error.message);
        return NextResponse.json({ error: "Falha Interna API" }, { status: 500 });
    }
}