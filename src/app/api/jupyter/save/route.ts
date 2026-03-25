import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { join, isAbsolute } from 'path';

export async function POST(req: NextRequest) {
  try {
    const { filePath, cwd, cells } = await req.json();

    if (!filePath || !cells) {
      return NextResponse.json({ error: 'filePath and cells are required' }, { status: 400 });
    }

    const fullPath = isAbsolute(filePath) ? filePath : join(cwd || process.cwd(), filePath);

    // Read original notebook to preserve metadata, nbformat, etc.
    let notebook: Record<string, unknown>;
    try {
      const content = await readFile(fullPath, 'utf-8');
      notebook = JSON.parse(content);
    } catch {
      // If file doesn't exist, create a minimal notebook
      notebook = {
        nbformat: 4,
        nbformat_minor: 2,
        metadata: {
          kernelspec: {
            display_name: 'Python 3',
            language: 'python',
            name: 'python3',
          },
          language_info: { name: 'python' },
        },
        cells: [],
      };
    }

    // Update cells — convert back to ipynb format
    notebook.cells = cells.map((cell: Record<string, unknown>) => {
      const source = cell.source as string || '';
      const cellType = cell.cell_type as string;
      const base: Record<string, unknown> = {
        cell_type: cellType,
        source: source.split('\n').map((line: string, i: number, arr: string[]) =>
          i < arr.length - 1 ? line + '\n' : line
        ),
        metadata: cell.metadata || {},
      };

      if (cellType === 'code') {
        base.execution_count = cell.execution_count ?? null;
        base.outputs = cell.outputs || [];
      }

      return base;
    });

    await writeFile(fullPath, JSON.stringify(notebook, null, 1) + '\n', 'utf-8');

    return NextResponse.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
