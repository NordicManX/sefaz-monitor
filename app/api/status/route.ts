import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const httpsAgent = new https.Agent({
    rejectUnauthorized: false, // Ignora erro de certificado do lado do servidor
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=1'
});

const PR_URL = 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4?wsdl';

async function checkRealEndpoint(url: string): Promise<{ status: 'online' | 'offline' | 'instavel', msg: string, latency: number }> {
    const start = Date.now();

    try {
        const response = await axios.get(url, {
            httpsAgent,
            timeout: 5000, // 5 segundos é suficiente para teste de porta
            headers: {
                // Tenta parecer um navegador real
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            validateStatus: () => true
        });

        // Se passar direto (raro sem certificado)
        return { status: 'online', msg: `OK (Status ${response.status})`, latency: Date.now() - start };

    } catch (error: any) {
        const latency = Date.now() - start;
        const msg = error.message || '';
        const code = error.code || '';

        console.log(`🔍 Diagnóstico PR: ${code} - ${msg}`);

        // --- AQUI ESTÁ A CORREÇÃO ---

        // Erro: "SSL alert number 42" ou "bad certificate"
        // SIGNIFICA: O servidor respondeu, mas exigiu certificado. Logo, está ONLINE.
        if (msg.includes('bad certificate') || msg.includes('SSL routines') || code === 'EPROTO') {
            return { status: 'online', msg: 'Online (Protegido por Certificado)', latency };
        }

        // Erro: "ECONNRESET" ou "socket hang up"
        // SIGNIFICA: O firewall da SEFAZ derrubou a conexão, mas existe algo lá.
        if (code === 'ECONNRESET' || msg.includes('socket hang up')) {
            return { status: 'instavel', msg: 'Online (Firewall Bloqueando)', latency };
        }

        // Erro: "403 Forbidden" (Lançado pelo Axios se não tratar validateStatus, mas aqui tratamos)
        if (msg.includes('403')) {
            return { status: 'online', msg: 'Online (Acesso Negado)', latency };
        }

        // SÓ É OFFLINE SE DER TIMEOUT (O servidor não respondeu nada)
        if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
            return { status: 'offline', msg: 'Timeout - Servidor não responde', latency: 0 };
        }

        // Outros erros de rede (DNS, Host inalcançável)
        if (code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
            return { status: 'offline', msg: 'DNS/Host Inacessível', latency: 0 };
        }

        // Por segurança, se for um erro desconhecido, marcamos como offline
        return { status: 'offline', msg: `Erro: ${msg}`, latency: 0 };
    }
}

// ... (O resto da função GET continua igual ao anterior)
export async function GET() {
    try {
        const prCheck = await checkRealEndpoint(PR_URL);

        // ... (resto do código de scraping e Supabase que já fizemos)
        // Mantendo apenas a parte final para contexto:

        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;

        // ... (lógica do crawler do portal nacional) ...
        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 10000,
            validateStatus: () => true,
            headers: { 'User-Agent': `Mozilla/5.0 ...` }
        });

        const $ = cheerio.load(response1.data);
        const results: any[] = [];

        $('table.tabelaListagemDados tr').each((i, row) => {
            // ... (Lógica de parse da tabela igual anterior) ...
            const cols = $(row).find('td');
            if (cols.length < 6) return;
            const estado = cols.eq(0).text().trim();

            // ... (Função getStatusColor igual) ...
            const getStatusColor = (i: number) => { /* ... */ return 'online' }; // Simplificado para exemplo

            // ... (Montagem do objeto igual) ...

            if (estado === 'PR') {
                // AQUI APLICAMOS O RESULTADO DA NOSSA NOVA LÓGICA
                const baseData = { /* ... */ }; // Seus dados base
                const nfeData = { ...baseData, modelo: 'NFe', estado: 'PR' };
                const nfceData = { ...baseData, modelo: 'NFCe', estado: 'PR' };

                // Força o status baseado no teste real
                // @ts-ignore
                nfceData.autorizacao = prCheck.status;
                // @ts-ignore
                nfceData.status_servico = prCheck.status;

                // Só muda o resto para offline se o teste real disser que caiu mesmo (Timeout)
                if (prCheck.status === 'offline') {
                    // @ts-ignore
                    nfceData.retorno_autorizacao = 'offline';
                    // @ts-ignore
                    nfceData.consulta = 'offline';
                    // @ts-ignore
                    nfceData.details = prCheck.msg;
                } else {
                    // Se deu erro de certificado (EPROTO), consideramos ONLINE
                    // @ts-ignore
                    nfceData.retorno_autorizacao = 'online';
                    // @ts-ignore
                    nfceData.consulta = 'online';
                }

                // Empurra para o array
                results.push(nfceData);
            } else {
                // Outros estados...
            }
        });

        // ... Salva no banco e retorna ...
        return NextResponse.json(results);

    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}