import { getExpandedPathsPath, readJsonFile, writeJsonFile } from '@cockpit/shared-utils';

// GET - Read expanded paths
export async function GET(request: Request) {
  const cwd = new URL(request.url).searchParams.get('cwd');

  if (!cwd) {
    return Response.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    const filePath = getExpandedPathsPath(cwd);
    const paths = await readJsonFile<string[]>(filePath, []);
    return Response.json({ paths });
  } catch (error) {
    console.error('Error reading expanded paths:', error);
    return Response.json({ error: 'Failed to read expanded paths' }, { status: 500 });
  }
}

// POST - Save expanded paths
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { cwd, paths } = body;

    if (!cwd || !Array.isArray(paths)) {
      return Response.json({ error: 'cwd and paths array are required' }, { status: 400 });
    }

    const filePath = getExpandedPathsPath(cwd);
    await writeJsonFile(filePath, paths);

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error saving expanded paths:', error);
    return Response.json({ error: 'Failed to save expanded paths' }, { status: 500 });
  }
}
