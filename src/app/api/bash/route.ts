import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/bash
 * Lightweight bash execution endpoint for Chat's ! prefix commands.
 * Does not use terminal WS and does not produce console bubbles.
 */
export async function POST(request: NextRequest) {
  try {
    const { command, cwd } = await request.json();

    if (!command || typeof command !== 'string') {
      return NextResponse.json({ error: 'Missing command' }, { status: 400 });
    }

    const timeout = 30000; // 30s

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      exec(command, {
        cwd: cwd || process.cwd(),
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env, FORCE_COLOR: '0' }, // Disable color output
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error?.code ?? (error ? 1 : 0),
        });
      });
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
