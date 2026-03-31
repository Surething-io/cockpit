import { NextResponse } from 'next/server';
import { spawn, execSync } from 'child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OLLAMA_BASE = 'http://localhost:11434';

/** Check if Ollama is reachable */
async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Check if ollama binary exists */
function findOllama(): string | null {
  try {
    const path = execSync('which ollama', { encoding: 'utf-8' }).trim();
    return path || null;
  } catch {
    return null;
  }
}

export async function POST() {
  try {
    // Already running?
    if (await isOllamaRunning()) {
      return NextResponse.json({ status: 'already_running' });
    }

    // Check if ollama is installed
    const ollamaPath = findOllama();
    if (!ollamaPath) {
      return NextResponse.json(
        { error: 'ollama_not_installed', message: 'Ollama is not installed. Visit https://ollama.com to install.' },
        { status: 404 }
      );
    }

    // Start ollama serve in background
    const child = spawn(ollamaPath, ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Wait for it to become ready (up to 8 seconds)
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isOllamaRunning()) {
        return NextResponse.json({ status: 'started' });
      }
    }

    return NextResponse.json({ error: 'ollama_start_timeout', message: 'Ollama started but not responding yet' }, { status: 504 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
