import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { supabase } from '@/lib/supabase';

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=1'
});

export async function GET() {
    try {
        const targetUrl = "https://www.nfe.fazenda.gov.br/portal/disponibilidade.aspx";
        const randomVer = Math.floor(Math.random() * 20) + 110;
        const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${randomVer}.0.0.0 Safari/537.36`;

        console.log(`1. Iniciando conexão manual (Chrome v${randomVer})...`);


        const response1 = await axios.get(targetUrl, {
            httpsAgent, timeout: 15000, maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: { 'User-Agent': userAgent, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Connection': 'keep-alive' }
        });

        let html = response1.data;
        let finalResponse = response1;

        if (response1.status === 302 || response1.status === 301) {
            console.log("2. Redirect detectado...");
            const cookies = response1.headers['set-cookie'];
            const redirectLocation = response1.headers.location;
            if (redirectLocation) {
                const nextUrl = redirectLocation.startsWith('http') ? redirectLocation : `https://www.nfe.fazenda.gov.br${redirectLocation}`;
                console.log(`3. Seguindo para: ${nextUrl}`);
                finalResponse = await axios.get(nextUrl, {
                    httpsAgent,
                    headers: { 'Cookie': cookies ? cookies.join('; ') : '', 'User-Agent': userAgent, 'Host': 'www.nfe.fazenda.gov.br' }
                });
                html = finalResponse.data;
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
            results.push({ ...baseData, modelo: 'NFCe' });
        });

        if (results.length === 0) {
            const pageTitle = $('title').text().trim() || "Sem Título";
            console.error("FALHA: Tabela vazia. Título:", pageTitle);
            return NextResponse.json({ error: "Bloqueio WAF", debug: pageTitle }, { status: 502 });
        }

        const { error: dbError } = await supabase.from('sefaz_logs').insert(results);

        if (dbError) console.error("Erro Supabase:", dbError.message);
        else console.log(`Sucesso! ${results.length} registros salvos (NFe + NFCe).`);

        return NextResponse.json(results);

    } catch (error: any) {
        console.error("ERRO CRÍTICO:", error.message);
        return NextResponse.json({ error: "Falha técnica", details: error.message }, { status: 500 });
    }
}