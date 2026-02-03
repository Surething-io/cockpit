import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';

export async function POST(request: NextRequest) {
  try {
    const { cwd } = await request.json();

    if (!cwd) {
      return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
    }

    // 执行 cursor 命令打开目录
    exec(`cursor "${cwd}"`, (error) => {
      if (error) {
        console.error('Failed to open cursor:', error);
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error opening cursor:', error);
    return NextResponse.json({ error: 'Failed to open cursor' }, { status: 500 });
  }
}
