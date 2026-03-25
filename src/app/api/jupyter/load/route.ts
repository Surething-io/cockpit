import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, access } from 'fs/promises';
import { join, isAbsolute } from 'path';

/** Minimal empty notebook structure */
function emptyNotebook() {
  return {
    nbformat: 4,
    nbformat_minor: 2,
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: {
        name: 'python',
        version: '3.x',
      },
    },
    cells: [] as Record<string, unknown>[],
  };
}

export async function POST(req: NextRequest) {
  try {
    const { filePath, cwd } = await req.json();

    if (!filePath) {
      return NextResponse.json({ error: 'filePath is required' }, { status: 400 });
    }

    const fullPath = isAbsolute(filePath) ? filePath : join(cwd || process.cwd(), filePath);

    // Check if file exists; if not, create an empty notebook
    let notebook: Record<string, unknown>;
    let created = false;

    try {
      await access(fullPath);
      const content = await readFile(fullPath, 'utf-8');
      const trimmed = content.trim();
      if (!trimmed) {
        // Empty file — initialize with empty notebook and write back
        notebook = emptyNotebook();
        await writeFile(fullPath, JSON.stringify(notebook, null, 1) + '\n', 'utf-8');
        created = true;
      } else {
        notebook = JSON.parse(trimmed);
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — create it
        notebook = emptyNotebook();
        await writeFile(fullPath, JSON.stringify(notebook, null, 1) + '\n', 'utf-8');
        created = true;
      } else if (err instanceof SyntaxError) {
        // Invalid JSON — treat as empty notebook
        notebook = emptyNotebook();
        await writeFile(fullPath, JSON.stringify(notebook, null, 1) + '\n', 'utf-8');
        created = true;
      } else {
        throw err;
      }
    }

    const nbformat = (notebook.nbformat as number) || 4;
    const metadata = (notebook.metadata as Record<string, unknown>) || {};
    const kernelspec = (metadata.kernelspec as Record<string, unknown>) || {};

    const cells = ((notebook.cells as Record<string, unknown>[]) || []).map((cell, idx) => ({
      index: idx,
      cell_type: cell.cell_type as string,
      source: Array.isArray(cell.source) ? (cell.source as string[]).join('') : (cell.source as string || ''),
      outputs: cell.outputs || [],
      execution_count: cell.execution_count ?? null,
      metadata: cell.metadata || {},
    }));

    return NextResponse.json({
      nbformat,
      metadata,
      kernelspec,
      cells,
      filePath: fullPath,
      created,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
