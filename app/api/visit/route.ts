import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {

        const { data: current } = await supabase
            .from('page_views')
            .select('views')
            .eq('id', 1)
            .single();

        const newCount = (current?.views || 0) + 1;


        const { error } = await supabase
            .from('page_views')
            .update({ views: newCount })
            .eq('id', 1);

        if (error) throw error;

        return NextResponse.json({ count: newCount });

    } catch (error) {
        return NextResponse.json({ count: 0 }, { status: 500 });
    }
}