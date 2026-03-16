import { NextRequest, NextResponse } from 'next/server';
import { networkInterfaces } from 'os';
import { join } from 'path';
import { getMacByIp, macToAuthorId } from '@/lib/arp';
import { REVIEW_DIR, readJsonFile, writeJsonFile, withFileLock, ensureDir } from '@/lib/paths';

const USERS_FILE = join(REVIEW_DIR, '_users.json');
type UsersMap = Record<string, { name: string; confirmedAt: number }>;

/**
 * 获取本机第一个非内部 IPv4 网卡的 MAC 地址
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
 * 从请求中解析客户端 IP，返回 MAC-based authorId
 */
function resolveAuthorId(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0].trim() || request.headers.get('x-real-ip') || '';

  // localhost → 用本机网卡 MAC
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost') {
    const localMac = getLocalMac();
    return localMac ? macToAuthorId(localMac) : null;
  }

  // 去掉 IPv4-mapped IPv6 前缀: ::ffff:10.0.0.2 → 10.0.0.2
  const cleanIp = ip.replace(/^::ffff:/, '');
  const mac = getMacByIp(cleanIp);
  return mac ? macToAuthorId(mac) : null;
}

/**
 * GET /api/review/identify
 * 返回 { authorId, name }
 * - authorId: MAC hash（null 表示无法识别）
 * - name: 已绑定的昵称（null 表示未绑定，前端需弹窗输入）
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
 * 绑定昵称到当前设备的 MAC authorId
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
