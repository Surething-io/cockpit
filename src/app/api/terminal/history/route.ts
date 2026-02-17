import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getTerminalHistoryPath, getTerminalOutputPath, getCockpitProjectDir, ensureParentDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 超过此阈值的 output 存到独立文件（4KB）
const OUTPUT_FILE_THRESHOLD = 4096;

interface CommandHistoryEntry {
  id: string;
  command: string;
  output: string;
  outputFile?: string; // 长输出存到独立文件时的引用
  exitCode?: number;
  timestamp: string;
  cwd: string;
}

// GET: 读取命令历史（分页）
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

      // 解析 JSONL
      const allEntries: CommandHistoryEntry[] = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean) as CommandHistoryEntry[];

      // 分页
      const start = page * pageSize;
      const end = start + pageSize;
      const entries = allEntries.slice(start, end);

      // 读取独立输出文件的内容
      for (const entry of entries) {
        if (entry.outputFile) {
          try {
            entry.output = await fs.readFile(entry.outputFile, 'utf-8');
          } catch {
            entry.output = '[输出文件已删除]';
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
    } catch (error: any) {
      // 文件不存在，返回空列表
      if (error.code === 'ENOENT') {
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

// DELETE: 删除命令历史
// 有 commandId 参数时删除单条；无 commandId 时清空整个 tab 历史
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
      // 单条删除
      try {
        const content = await fs.readFile(historyPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        const remaining: string[] = [];

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.id === commandId) {
              // 删除关联的输出文件
              if (entry.outputFile) {
                await fs.unlink(entry.outputFile).catch(() => {});
              }
              continue; // 跳过该条
            }
          } catch { /* 保留无法解析的行 */ }
          remaining.push(line);
        }

        if (remaining.length > 0) {
          await fs.writeFile(historyPath, remaining.join('\n') + '\n', 'utf-8');
        } else {
          await fs.unlink(historyPath).catch(() => {});
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    } else {
      // 清空整个 tab 历史
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
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
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

// POST: 保存命令历史条目
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

    // 长输出存到独立文件
    const entryToSave = { ...entry };
    if (entry.output && entry.output.length > OUTPUT_FILE_THRESHOLD) {
      const outputPath = getTerminalOutputPath(cwd, entry.id);
      await fs.writeFile(outputPath, entry.output, 'utf-8');
      entryToSave.output = ''; // JSONL 里不存内容
      entryToSave.outputFile = outputPath; // 存引用路径
    }

    // 读取现有历史
    let existingLines: string[] = [];
    try {
      const content = await fs.readFile(historyPath, 'utf-8');
      existingLines = content.trim().split('\n').filter(Boolean);
    } catch (e) {
      // 文件不存在，从空开始
    }

    // 幂等保护：如果该 commandId 已存在，跳过写入
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

    // 限制最多 100 条时，清理被淘汰条目的输出文件
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

    // 追加新条目
    existingLines.push(JSON.stringify(entryToSave));

    // 写回文件
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
