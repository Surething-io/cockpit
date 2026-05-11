import { getRecentFilesPath, readJsonFile, writeJsonFile } from '@cockpit/shared-utils';

const MAX_RECENT_FILES = 15;

export interface RecentFileEntry {
  path: string;
  scrollLine?: number;   // First visible line on screen (1-based)
  cursorLine?: number;   // Cursor line (1-based)
  cursorCol?: number;    // Cursor column (1-based)
}

/** Read and normalize: backward compatible with old string entries, filter invalid data */
function normalize(raw: unknown[]): RecentFileEntry[] {
  return raw
    .map(item => typeof item === 'string' ? { path: item } : item as RecentFileEntry)
    .filter(item => item && typeof item.path === 'string' && item.path);
}

// GET - Read recent files
export async function GET(request: Request) {
  const cwd = new URL(request.url).searchParams.get('cwd');

  if (!cwd) {
    return Response.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    const filePath = getRecentFilesPath(cwd);
    const raw = await readJsonFile<unknown[]>(filePath, []);
    const files = normalize(raw);
    return Response.json({ files });
  } catch (error) {
    console.error('Error reading recent files:', error);
    return Response.json({ error: 'Failed to read recent files' }, { status: 500 });
  }
}

// POST - Add file / update position
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { cwd, file, scrollLine, cursorLine, cursorCol } = body as {
      cwd: string; file: string;
      scrollLine?: number; cursorLine?: number; cursorCol?: number;
    };

    if (!cwd || !file) {
      return Response.json({ error: 'cwd and file are required' }, { status: 400 });
    }

    const filePath = getRecentFilesPath(cwd);
    let files = normalize(await readJsonFile<unknown[]>(filePath, []));

    const hasPosition = scrollLine != null || cursorLine != null;

    if (hasPosition) {
      // Update position info for existing entry without changing order
      const idx = files.findIndex(f => f.path === file);
      if (idx !== -1) {
        if (scrollLine != null) files[idx].scrollLine = scrollLine;
        if (cursorLine != null) files[idx].cursorLine = cursorLine;
        if (cursorCol != null) files[idx].cursorCol = cursorCol;
      }
      // Ignore if entry does not exist (should not happen)
    } else {
      // Add file to top of list (deduplicated)
      files = files.filter(f => f.path !== file);
      files.unshift({ path: file });
      files = files.slice(0, MAX_RECENT_FILES);
    }

    await writeJsonFile(filePath, files);
    return Response.json({ files });
  } catch (error) {
    console.error('Error updating recent file:', error);
    return Response.json({ error: 'Failed to update recent file' }, { status: 500 });
  }
}
