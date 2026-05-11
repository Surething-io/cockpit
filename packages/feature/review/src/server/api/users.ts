import { join } from 'path';
import { REVIEW_DIR, readJsonFile, writeJsonFile, withFileLock, ensureDir } from '@cockpit/shared-utils';

const USERS_FILE = join(REVIEW_DIR, '_users.json');

interface UserRecord {
  name: string;
  confirmedAt: number;
}

type UsersMap = Record<string, UserRecord>;

// GET - Return all user mappings { [authorId]: { name, confirmedAt } }
export async function GET() {
  try {
    await ensureDir(REVIEW_DIR);
    const users = await readJsonFile<UsersMap>(USERS_FILE, {});
    return Response.json({ users });
  } catch (error) {
    console.error('Error reading users:', error);
    return Response.json({ error: 'Failed to read users' }, { status: 500 });
  }
}

// POST - Create/update a single user { authorId, name }
export async function POST(request: Request) {
  try {
    const { authorId, name } = await request.json();
    if (!authorId || !name) {
      return Response.json({ error: 'authorId and name are required' }, { status: 400 });
    }

    await ensureDir(REVIEW_DIR);

    const updated = await withFileLock(USERS_FILE, async () => {
      const users = await readJsonFile<UsersMap>(USERS_FILE, {});
      users[authorId] = { name: name.trim(), confirmedAt: Date.now() };
      await writeJsonFile(USERS_FILE, users);
      return users;
    });

    return Response.json({ users: updated });
  } catch (error) {
    console.error('Error updating user:', error);
    return Response.json({ error: 'Failed to update user' }, { status: 500 });
  }
}
