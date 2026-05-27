import { NextResponse } from 'next/server';
import { getAnonSupabase } from '@/lib/supabase/server';
import { listLocations } from '@/lib/agent/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = getAnonSupabase();
    const locations = await listLocations(supabase);
    return NextResponse.json({ locations });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, locations: [] }, { status: 500 });
  }
}
