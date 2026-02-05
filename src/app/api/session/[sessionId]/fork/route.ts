import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { getClaudeSessionPath } from '@/lib/paths';

export const runtime = 'nodejs';

interface ForkRequestBody {
  cwd: string;
  // 可选：从哪条消息开始 fork（通过 uuid），不传则复制全部
  fromMessageUuid?: string;
}

/**
 * 判断是否是"真正的用户消息"（不是 tool_result）
 * 真正的用户消息：type=user 且 content 包含 text 类型（不只是 tool_result）
 */
function isRealUserMessage(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user') return false;
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message) return false;
  const content = message.content;
  if (!Array.isArray(content)) return typeof content === 'string';
  // 检查是否有 text 类型的 content（真正的用户输入）
  return content.some(
    (block: Record<string, unknown>) => block.type === 'text'
  );
}

/**
 * POST: Fork 一个 session，创建新的分支会话
 *
 * 工作原理：
 * 1. 读取原始 session 的 JSONL 文件
 * 2. 生成新的 sessionId
 * 3. 替换所有记录中的 sessionId
 * 4. 写入新的 JSONL 文件
 *
 * Fork 逻辑（按 turn 截断）：
 * - 找到指定 uuid 所在的消息
 * - 继续复制该 turn 的所有后续消息（assistant 回复、tool_use、tool_result 等）
 * - 直到遇到下一个"真正的用户消息"为止
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId: originalSessionId } = await params;
    const body: ForkRequestBody = await request.json();
    const { cwd, fromMessageUuid } = body;

    if (!cwd) {
      return NextResponse.json(
        { error: 'Missing cwd parameter' },
        { status: 400 }
      );
    }

    // 获取原始 session 文件路径
    const originalPath = getClaudeSessionPath(cwd, originalSessionId);

    if (!existsSync(originalPath)) {
      return NextResponse.json(
        { error: 'Original session not found' },
        { status: 404 }
      );
    }

    // 生成新的 sessionId
    const newSessionId = randomUUID();

    // 读取并处理 JSONL 文件
    const newLines: string[] = [];
    const fileStream = createReadStream(originalPath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    // 状态机：
    // - 'collecting': 正常收集消息
    // - 'found_target': 找到目标消息，继续收集直到下一个真正的用户消息
    // - 'done': 完成
    let state: 'collecting' | 'found_target' | 'done' = 'collecting';

    for await (const line of rl) {
      if (state === 'done') break;
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // 状态处理
        if (state === 'found_target') {
          // 如果遇到下一个真正的用户消息，停止
          if (isRealUserMessage(entry)) {
            state = 'done';
            break;
          }
        }

        // 检查是否到达目标消息
        if (fromMessageUuid && entry.uuid === fromMessageUuid) {
          state = 'found_target';
        }

        // 替换 sessionId
        entry.sessionId = newSessionId;

        // 将修改后的记录添加到新文件内容
        newLines.push(JSON.stringify(entry));
      } catch {
        // 如果解析失败，保留原始行（但替换 sessionId 字符串）
        const modifiedLine = line.replace(
          new RegExp(originalSessionId, 'g'),
          newSessionId
        );
        newLines.push(modifiedLine);
      }
    }

    // 写入新的 JSONL 文件
    const newPath = getClaudeSessionPath(cwd, newSessionId);
    await writeFile(newPath, newLines.join('\n') + '\n', 'utf-8');

    return NextResponse.json({
      success: true,
      originalSessionId,
      newSessionId,
      messageCount: newLines.length,
    });
  } catch (error) {
    console.error('Fork session error:', error);
    return NextResponse.json(
      { error: 'Failed to fork session' },
      { status: 500 }
    );
  }
}
