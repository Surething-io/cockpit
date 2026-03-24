import { NextRequest, NextResponse } from 'next/server';
import { networkInterfaces } from 'os';
import { join } from 'path';
import { getMacByIp, macToAuthorId } from '@/lib/arp';
import { REVIEW_DIR, readJsonFile, writeJsonFile, withFileLock, ensureDir } from '@/lib/paths';

const USERS_FILE = join(REVIEW_DIR, '_users.json');
type UsersMap = Record<string, { name: string; confirmedAt: number }>;

/**
 * Get the MAC address of the first non-internal IPv4 network interface on the local machine
 */
function getLocalMac(): string | null {
  const interfaces = networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface || []) {
      if (alias.family === 'IPv4' && !alias.internal && alias.mac && alias.mac !== '00:00:00:00:00:00') {
        return alias.mac.toLowerCase();
      }
    }
  }
  return null;
}

/**
 * Parse the client IP from the request and return a MAC-based authorId
 */
function resolveAuthorId(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0].trim() || request.headers.get('x-real-ip') || '';

  // localhost → use the local machine's NIC MAC
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost') {
    const localMac = getLocalMac();
    return localMac ? macToAuthorId(localMac) : null;
  }

  // Strip IPv4-mapped IPv6 prefix: ::ffff:10.0.0.2 → 10.0.0.2
  const cleanIp = ip.replace(/^::ffff:/, '');
  const mac = getMacByIp(cleanIp);
  return mac ? macToAuthorId(mac) : null;
}

/**
 * GET /api/review/identify
 * Returns { authorId, name }
 * - authorId: MAC hash (null means unidentifiable)
 * - name: bound nickname (null means not yet bound; frontend should prompt for input)
 */
export async function GET(request: NextRequest) {
  const authorId = resolveAuthorId(request);
  if (!authorId) {
    return NextResponse.json({ authorId: null, name: null });
  }

  await ensureDir(REVIEW_DIR);
  const users = await readJsonFile<UsersMap>(USERS_FILE, {});
  const name = users[authorId]?.name || null;

  return NextResponse.json({ authorId, name });
}

/**
 * POST /api/review/identify
 * Bind a nickname to the current device's MAC authorId
 * body: { name }
 */
export async function POST(request: NextRequest) {
  try {
    const { name } = await request.json();

    const authorId = resolveAuthorId(request);
    if (!authorId || !name?.trim()) {
      return NextResponse.json({ error: 'Cannot identify device or missing name' }, { status: 400 });
    }

    const trimmedName = name.trim();
    await ensureDir(REVIEW_DIR);

    await withFileLock(USERS_FILE, async () => {
      const users = await readJsonFile<UsersMap>(USERS_FILE, {});
      users[authorId] = { name: trimmedName, confirmedAt: Date.now() };
      await writeJsonFile(USERS_FILE, users);
    });

    return NextResponse.json({ authorId, name: trimmedName });
  } catch (error) {
    console.error('Error in identify POST:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
