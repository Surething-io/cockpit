import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import { getTerminalHistoryPath, getTerminalOutputPath, ensureParentDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Outputs exceeding this threshold are stored in a separate file (4KB)
const OUTPUT_FILE_THRESHOLD = 4096;

// Unified history entry (commands + browser mixed storage)
// Defaults to 'command' when type is missing (backward compatible)
interface HistoryEntry {
  type?: 'command' | 'browser' | 'database';
  id: string;
  timestamp: string;
  // command-type fields
  command?: string;
  output?: string;
  outputFile?: string; // Reference path when long output is stored in a separate file
  exitCode?: number;
  cwd?: string;
  usePty?: boolean;
  // browser-type fields
  url?: string;
  sleeping?: boolean;
  // database-type fields
  connectionString?: string;
  displayName?: string;
}

// GET: Read command history (paginated)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get('cwd');
    const tabId = searchParams.get('tabId');
    const page = parseInt(searchParams.get('page') || '0', 10);
    const pageSize = parseInt(searchParams.get('pageSize') || '20', 10);

    if (!cwd || !tabId) {
      return new Response(JSON.stringify({ error: 'Missing cwd or tabId parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const historyPath = getTerminalHistoryPath(cwd, tabId);

    try {
      const content = await fs.readFile(historyPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      // Parse JSONL
      const allEntries: HistoryEntry[] = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as HistoryEntry[];

      // Paginate
      const start = page * pageSize;
      const end = start + pageSize;
      const entries = allEntries.slice(start, end);

      // Read the content of separate output files
      for (const entry of entries) {
        if (entry.outputFile) {
          try {
            entry.output = await fs.readFile(entry.outputFile, 'utf-8');
          } catch {
            entry.output = '[Output file deleted]';
          }
          delete entry.outputFile;
        }
      }

      return new Response(
        JSON.stringify({
          entries,
          total: allEntries.length,
          page,
          pageSize,
          hasMore: end < allEntries.length,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error: unknown) {
      // File does not exist, return empty list
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Response(
          JSON.stringify({
            entries: [],
            total: 0,
            page: 0,
            pageSize,
            hasMore: false,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error('Get terminal history error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// DELETE: Delete command history
// With a commandId param: delete a single entry; without commandId: clear the entire tab history
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get('cwd');
    const tabId = searchParams.get('tabId');
    const commandId = searchParams.get('commandId');

    if (!cwd || !tabId) {
      return new Response(JSON.stringify({ error: 'Missing cwd or tabId parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const historyPath = getTerminalHistoryPath(cwd, tabId);

    if (commandId) {
      // Delete a single entry
      try {
        const content = await fs.readFile(historyPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        const remaining: string[] = [];

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.id === commandId) {
              // Delete the associated output file
              if (entry.outputFile) {
                await fs.unlink(entry.outputFile).catch(() => {});
              }
              continue; // Skip this entry
            }
          } catch { /* Keep lines that cannot be parsed */ }
          remaining.push(line);
        }

        if (remaining.length > 0) {
          await fs.writeFile(historyPath, remaining.join('\n') + '\n', 'utf-8');
        } else {
          await fs.unlink(historyPath).catch(() => {});
        }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    } else {
      // Clear the entire tab history
      try {
        const content = await fs.readFile(historyPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.outputFile) {
              await fs.unlink(entry.outputFile).catch(() => {});
            }
          } catch { /* ignore parse errors */ }
        }
      } catch { /* file may not exist */ }

      try {
        await fs.unlink(historyPath);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Delete terminal history error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// POST: Save a command history entry
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, tabId, entry } = body;

    if (!cwd || !tabId || !entry) {
      return new Response(JSON.stringify({ error: 'Missing parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const historyPath = getTerminalHistoryPath(cwd, tabId);
    await ensureParentDir(historyPath);

    // Store long output in a separate file
    const entryToSave = { ...entry };
    if (entry.output && entry.output.length > OUTPUT_FILE_THRESHOLD) {
      const outputPath = getTerminalOutputPath(cwd, entry.id);
      await fs.writeFile(outputPath, entry.output, 'utf-8');
      entryToSave.output = ''; // Don't store content in JSONL
      entryToSave.outputFile = outputPath; // Store the reference path
    }

    // Read existing history
    let existingLines: string[] = [];
    try {
      const content = await fs.readFile(historyPath, 'utf-8');
      existingLines = content.trim().split('\n').filter(Boolean);
    } catch {
      // File does not exist, start empty
    }

    // Idempotency guard: if this commandId already exists, skip writing
    const entryId = entry.id;
    if (entryId) {
      const alreadyExists = existingLines.some((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed.id === entryId;
        } catch {
          return false;
        }
      });
      if (alreadyExists) {
        return new Response(JSON.stringify({ success: true, skipped: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // When capped at 100 entries, clean up output files for evicted entries
    if (existingLines.length >= 100) {
      const removedLines = existingLines.slice(0, existingLines.length - 99);
      for (const line of removedLines) {
        try {
          const old = JSON.parse(line);
          if (old.outputFile) {
            await fs.unlink(old.outputFile).catch(() => {});
          }
        } catch { /* ignore */ }
      }
      existingLines = existingLines.slice(-99);
    }

    // Append new entry
    existingLines.push(JSON.stringify(entryToSave));

    // Write back to file
    await fs.writeFile(historyPath, existingLines.join('\n') + '\n', 'utf-8');

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Save terminal history error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// PATCH: Update partial fields of a single history entry (e.g. sleeping state)
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, tabId, id, fields } = body;

    if (!cwd || !tabId || !id || !fields) {
      return new Response(JSON.stringify({ error: 'Missing parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const historyPath = getTerminalHistoryPath(cwd, tabId);

    try {
      const content = await fs.readFile(historyPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      let updated = false;

      const newLines = lines.map(line => {
        try {
          const entry = JSON.parse(line);
          if (entry.id === id) {
            updated = true;
            return JSON.stringify({ ...entry, ...fields });
          }
        } catch { /* keep original */ }
        return line;
      });

      if (updated) {
        await fs.writeFile(historyPath, newLines.join('\n') + '\n', 'utf-8');
      }

      return new Response(JSON.stringify({ success: true, updated }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e: unknown) {
      if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Response(JSON.stringify({ success: true, updated: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw e;
    }
  } catch (error) {
    console.error('Patch terminal history error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
