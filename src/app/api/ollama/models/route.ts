import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OLLAMA_BASE = 'http://localhost:11434';

export async function GET() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return NextResponse.json({ error: 'Ollama returned error', status: res.status }, { status: 502 });
    }
    const data = await res.json();
    const models = ((data.models || []) as Array<{ name: string; size: number; modified_at: string; details?: { family?: string; parameter_size?: string } }>).map((m) => ({
      name: m.name,
      size: m.size,
      modified_at: m.modified_at,
      family: m.details?.family,
      parameter_size: m.details?.parameter_size,
    }));
    return NextResponse.json({ models });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    // Connection refused means Ollama is not running
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('abort')) {
      return NextResponse.json({ error: 'ollama_not_running' }, { status: 503 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
