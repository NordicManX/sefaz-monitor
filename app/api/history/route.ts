import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const uf = searchParams.get('uf');
        const modelo = searchParams.get('modelo') || 'NFe';

        if (!uf) return NextResponse.json({ error: 'UF obrigatoria' }, { status: 400 });

        const { data, error } = await supabase
            .from('sefaz_logs')
            .select('*')
            .eq('estado', uf)
            .eq('modelo', modelo)
            .order('created_at', { ascending: false })
            .limit(30);

        if (error) throw error;

        return NextResponse.json(data);

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}