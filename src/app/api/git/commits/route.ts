import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const branch = searchParams.get('branch') || 'HEAD';
  const limit = parseInt(searchParams.get('limit') || '50', 10);

  try {
    // 获取提交历史
    // 格式: hash|shortHash|author|authorEmail|date|subject
    const format = '%H|%h|%an|%ae|%ci|%s';
    const { stdout } = await execAsync(
      `git log ${branch} --format="${format}" -n ${limit}`,
      { cwd, maxBuffer: 10 * 1024 * 1024 }
    );

    const commits = stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash, shortHash, author, authorEmail, date, ...subjectParts] = line.split('|');
        const subject = subjectParts.join('|'); // 处理 subject 中可能包含 | 的情况
        return {
          hash,
          shortHash,
          author,
          authorEmail,
          date,
          subject,
          relativeDate: getRelativeDate(new Date(date)),
        };
      });

    return NextResponse.json({ commits });
  } catch (error) {
    console.error('Error getting commits:', error);
    return NextResponse.json(
      { error: 'Failed to get commits' },
      { status: 500 }
    );
  }
}

function getRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffWeek < 4) return `${diffWeek}w ago`;
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${diffYear}y ago`;
}
