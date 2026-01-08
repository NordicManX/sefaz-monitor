import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import crypto from 'crypto'; // Necessário para ajustar criptografia legacy
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// CONFIGURAÇÃO NUCLEAR PARA SERVIDORES LEGADOS (SEFAZ)
// Isso permite que o Node converse com servidores antigos sem travar no handshake
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    // Permite renegociação insegura (comum em governo)
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    // Permite cifras antigas e fracas (necessário para handshakes velhos)
    ciphers: 'ALL@SECLEVEL=0',
    minVersion: 'TLSv1',
    keepAlive: false // Força nova conexão sempre para evitar cache de socket fechado
});

const PR_URL = 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4?wsdl';

async function checkRealEndpoint(url: string): Promise<{ status: 'online' | 'offline' | 'instavel', msg: string, latency: number }> {
    const start = Date.now();

    try {
        // Timeout curto (5s). Se o servidor não responder nada em 5s, aí sim está morto.
        const response = await axios.get(url, {
            httpsAgent,
            timeout: 5000,
            headers: {
                // Headers idênticos ao Chrome para evitar bloqueio por WAF
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'close'
            },
            // Não estourar erro se o status for 403, 500, 404, etc.
            validateStatus: () => true
        });

        // Se chegou aqui, o servidor respondeu HTTP. Está VIVO.
        return { status: 'online', msg: `OK (HTTP ${response.status})`, latency: Date.now() - start };

    } catch (error: any) {
        const latency = Date.now() - start;
        const msg = (error.message || '').toLowerCase();
        const code = error.code || '';

        console.log(`🔍 DEBUG PR: Code=[${code}] Msg=[${msg}]`);

        // --- LISTA DE ERROS QUE SIGNIFICAM "ONLINE" ---

        // 1. EPROTO / bad certificate: O servidor respondeu "cadê seu certificado?" -> ONLINE
        if (code === 'EPROTO' || msg.includes('certificate')) {
            return { status: 'online', msg: 'Online (Protegido)', latency };
        }

        // 2. socket hang up / ECONNRESET: O firewall da SEFAZ cortou o TCP -> ONLINE
        // Um servidor desligado não reseta conexão, ele dá timeout.
        if (code === 'ECONNRESET' || msg.includes('socket hang up')) {
            return { status: 'online', msg: 'Online (Firewall Ativo)', latency };
        }

        // 3. Client network socket disconnected: O Node tentou conectar TLS e o servidor fechou na cara -> ONLINE
        if (msg.includes('socket disconnected')) {
            return { status: 'online', msg: 'Online (TLS Handshake recusado)', latency };
        }

        // 4. Erros de leitura SSL genéricos (openssl error) -> ONLINE
        if (msg.includes('ssl routines') || msg.includes('handshake failure')) {
            return { status: 'online', msg: 'Online (SSL Mismatch)', latency };
        }

        // --- SÓ É OFFLINE SE DER TIMEOUT OU DNS ---

        if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
            return { status: 'offline', msg: 'Timeout (Sem resposta)', latency: 0 };
        }

        if (code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
            return { status: 'offline', msg: 'DNS/Host não encontrado', latency: 0 };
        }

        // Se for algo muito bizarro, assume offline
        return { status: 'offline', msg: `Erro: ${code}`, latency: 0 };
    }
}

export async function GET() {
    try {
        // 1. Teste Real (Focado no PR)
        const prCheck = await checkRealEndpoint(PR_URL);

        // 2. Crawler de Backup (Portal Nacional)
        // Mantemos isso para pegar os dados dos outros estados e preencher lacunas
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;

        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 8000,
            validateStatus: () => true,
            headers: { 'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/${randomVer}.0.0.0 Safari/537.36` }
        });

        const $ = cheerio.load(response1.data);
        const results: any[] = [];

        // Parsing da tabela HTML
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
                return 'online'; // Fallback otimista
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

            // SE FOR PARANÁ (PR), SOBRESCREVE COM NOSSO TESTE REAL
            if (estado === 'PR') {
                const nfceData = { ...baseStatus, modelo: 'NFCe' };
                const nfeData = { ...baseStatus, modelo: 'NFe' };

                // Aplica o resultado do teste real (ping na URL da SEFAZ PR)
                // @ts-ignore
                nfceData.autorizacao = prCheck.status;
                // @ts-ignore
                nfceData.status_servico = prCheck.status;
                nfceData.latency = prCheck.latency;

                // Se o nosso teste deu ERRO CRÍTICO (Timeout), marca tudo offline
                if (prCheck.status === 'offline') {
                    // @ts-ignore
                    nfceData.retorno_autorizacao = 'offline';
                    // @ts-ignore
                    nfceData.consulta = 'offline';
                    // @ts-ignore
                    nfceData.details = prCheck.msg;
                } else {
                    // Se o teste deu Online (mesmo com erro de certificado), garante que fica verde
                    // @ts-ignore
                    nfceData.retorno_autorizacao = 'online';
                    // @ts-ignore
                    nfceData.consulta = 'online';
                }

                results.push(nfceData);
                results.push(nfeData); // NFe mantemos o do portal nacional ou duplicamos a lógica se quiser
            } else {
                results.push({ ...baseStatus, modelo: 'NFe' });
                results.push({ ...baseStatus, modelo: 'NFCe' });
            }
        });

        // Backup: Se o crawler falhar e não tiver nada, retorna só o PR manual
        if (results.length === 0) {
            return NextResponse.json([{
                estado: 'PR', modelo: 'NFCe',
                autorizacao: prCheck.status,
                status_servico: prCheck.status,
                retorno_autorizacao: prCheck.status,
                inutilizacao: 'online',
                consulta: prCheck.status,
                latency: prCheck.latency,
                details: prCheck.msg
            }]);
        }

        // Opcional: Salvar no Supabase
        try {
            // Filtrar apenas PR para não lotar o banco (opcional)
            const prLogs = results.filter(r => r.estado === 'PR');
            if (prLogs.length > 0) {
                await supabase.from('sefaz_logs').insert(prLogs);
            }
        } catch (err) { console.error('Erro banco:', err); }

        return NextResponse.json(results, {
            headers: { 'Cache-Control': 'no-store, no-cache' }
        });

    } catch (error: any) {
        console.error("ERRO GERAL:", error.message);
        return NextResponse.json({ error: "Falha técnica" }, { status: 500 });
    }
}