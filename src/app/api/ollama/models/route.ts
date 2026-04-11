import { NextResponse } from 'next/server';
import { getBaseURL } from '@/lib/ollama-env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  details?: { family?: string; parameter_size?: string };
}

interface OpenAIModel {
  id: string;
  created?: number;
  owned_by?: string;
}

// Try Ollama native API first, then fallback to OpenAI-compatible /v1/models
async function fetchModels() {
  const base = getBaseURL();

  // Attempt 1: Ollama /api/tags
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models : [];
      if (models.length > 0) {
        return (models as OllamaModel[]).map((m) => ({
          name: m.name,
          size: m.size,
          modified_at: m.modified_at,
          family: m.details?.family,
          parameter_size: m.details?.parameter_size,
        }));
      }
      // models empty or missing — fall through (might not be Ollama)
    }
  } catch {
    // fall through to OpenAI-compatible attempt
  }

  // Attempt 2: OpenAI-compatible /v1/models (LM Studio, vLLM, etc.)
  const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const data = await res.json();
  return ((data.data || []) as OpenAIModel[]).map((m) => ({
    name: m.id,
    size: 0,
    modified_at: m.created ? new Date(m.created * 1000).toISOString() : '',
    family: m.owned_by || undefined,
    parameter_size: undefined,
  }));
}

export async function GET() {
  try {
    const models = await fetchModels();
    return NextResponse.json({ models });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('abort')) {
      return NextResponse.json({ error: 'ollama_not_running' }, { status: 503 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
