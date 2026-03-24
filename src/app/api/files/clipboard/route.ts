import { NextRequest, NextResponse } from 'next/server';
import { stat } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { isMac, isWindows } from '@/lib/platform';

const execFileAsync = promisify(execFile);

/**
 * POST /api/files/clipboard — Write file reference to system clipboard
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, path: filePath } = body;

    if (!cwd || !filePath) {
      return NextResponse.json({ error: 'Missing cwd or path' }, { status: 400 });
    }

    const basePath = resolve(cwd);
    const fullPath = resolve(join(basePath, filePath));

    if (!fullPath.startsWith(basePath + sep)) {
      return NextResponse.json({ error: '不允许操作此路径' }, { status: 403 });
    }

    await stat(fullPath);

    if (isMac) {
      await execFileAsync('osascript', ['-e', `set the clipboard to POSIX file "${fullPath}"`]);
    } else if (isWindows) {
      execSync(`powershell -Command "Set-Clipboard -Value '${fullPath.replace(/'/g, "''")}'"`);
    } else {
      // Linux: xclip, fallback xsel
      try {
        await execFileAsync('xclip', ['-selection', 'clipboard'], { input: fullPath } as never);
      } catch {
        execSync(`echo -n '${fullPath.replace(/'/g, "\\'")}' | xsel --clipboard`);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/files/clipboard — Read file path from system clipboard
 */
export async function GET() {
  try {
    let clipPath: string | null = null;

    if (isMac) {
      try {
        const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']);
        clipPath = stdout.trim().replace(/\/$/, '');
      } catch { /* Clipboard does not contain a file reference */ }
    } else if (isWindows) {
      try {
        const result = execSync('powershell -Command "Get-Clipboard"', { encoding: 'utf8', timeout: 3000 }).trim();
        if (result && !result.includes('\n')) clipPath = result;
      } catch { /* ignore */ }
    } else {
      // Linux: xclip, fallback xsel
      try {
        const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-o']);
        const result = stdout.trim();
        if (result && !result.includes('\n')) clipPath = result;
      } catch {
        try {
          const result = execSync('xsel --clipboard --output', { encoding: 'utf8', timeout: 3000 }).trim();
          if (result && !result.includes('\n')) clipPath = result;
        } catch { /* ignore */ }
      }
    }

    if (clipPath) {
      try {
        await stat(clipPath);
        return NextResponse.json({ path: clipPath });
      } catch { /* Not a valid file path */ }
    }

    return NextResponse.json({ path: null });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
