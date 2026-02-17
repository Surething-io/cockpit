import { NextRequest } from 'next/server';
import { execSync } from 'child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface InterruptRequest {
  pid: number;
}

// 获取进程的所有后代进程 PID（深度优先，叶子进程在前）
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];

  function collect(parentPid: number) {
    try {
      const result = execSync(`pgrep -P ${parentPid}`, {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      const childPids = result.split('\n').filter(Boolean).map(Number);

      for (const childPid of childPids) {
        collect(childPid); // 先收集孙进程
        descendants.push(childPid);
      }
    } catch {
      // 没有子进程
    }
  }

  collect(pid);
  return descendants;
}

export async function POST(request: NextRequest) {
  try {
    const body: InterruptRequest = await request.json();
    const { pid } = body;

    if (!pid) {
      return new Response(JSON.stringify({ error: 'Missing pid' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 收集所有后代进程 PID（叶子在前）
    const descendants = getDescendantPids(pid);
    // 加上主进程
    const allPids = [...descendants, pid];

    // 第一轮：发送 SIGTERM
    for (const p of allPids) {
      try { process.kill(p, 'SIGTERM'); } catch { /* 忽略 */ }
    }

    // 1 秒后检查是否还存活，存活则 SIGKILL
    setTimeout(() => {
      for (const p of allPids) {
        try {
          process.kill(p, 0); // 检查进程是否存在
          process.kill(p, 'SIGKILL'); // 还在就强杀
        } catch {
          // 已经退出了
        }
      }
    }, 1000);

    return new Response(
      JSON.stringify({ success: true, killed: allPids }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Interrupt command error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
