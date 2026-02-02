import { NextRequest, NextResponse } from 'next/server';
import { getCommentsFilePath, readJsonFile, writeJsonFile } from '@/lib/paths';

export interface CodeComment {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  createdAt: number;
  updatedAt?: number;
}

interface CommentsData {
  comments: CodeComment[];
}

// GET - 获取文件评论
// ?cwd=xxx&filePath=xxx (filePath 可选，不传则返回所有)
export async function GET(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get('cwd');
  const filePath = request.nextUrl.searchParams.get('filePath');

  if (!cwd) {
    return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    const dataPath = getCommentsFilePath(cwd);
    const data = await readJsonFile<CommentsData>(dataPath, { comments: [] });

    // 如果指定了 filePath，只返回该文件的评论
    if (filePath) {
      const fileComments = data.comments.filter(c => c.filePath === filePath);
      return NextResponse.json({ comments: fileComments });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error reading comments:', error);
    return NextResponse.json({ error: 'Failed to read comments' }, { status: 500 });
  }
}

// POST - 添加评论
// body: { cwd, filePath, startLine, endLine, content }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, filePath, startLine, endLine, content } = body;

    if (!cwd || !filePath || startLine === undefined || endLine === undefined || content === undefined) {
      return NextResponse.json(
        { error: 'cwd, filePath, startLine, endLine, and content are required' },
        { status: 400 }
      );
    }

    const dataPath = getCommentsFilePath(cwd);
    const data = await readJsonFile<CommentsData>(dataPath, { comments: [] });

    const newComment: CodeComment = {
      id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      filePath,
      startLine,
      endLine,
      content,
      createdAt: Date.now(),
    };

    data.comments.push(newComment);
    await writeJsonFile(dataPath, data);

    return NextResponse.json({ comment: newComment });
  } catch (error) {
    console.error('Error adding comment:', error);
    return NextResponse.json({ error: 'Failed to add comment' }, { status: 500 });
  }
}

// PUT - 更新评论
// body: { cwd, id, content }
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, id, content } = body;

    if (!cwd || !id || content === undefined) {
      return NextResponse.json(
        { error: 'cwd, id, and content are required' },
        { status: 400 }
      );
    }

    const dataPath = getCommentsFilePath(cwd);
    const data = await readJsonFile<CommentsData>(dataPath, { comments: [] });

    const commentIndex = data.comments.findIndex(c => c.id === id);
    if (commentIndex === -1) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    data.comments[commentIndex] = {
      ...data.comments[commentIndex],
      content,
      updatedAt: Date.now(),
    };

    await writeJsonFile(dataPath, data);

    return NextResponse.json({ comment: data.comments[commentIndex] });
  } catch (error) {
    console.error('Error updating comment:', error);
    return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
  }
}

// DELETE - 删除评论
// ?cwd=xxx&id=xxx 删除单个评论
// ?cwd=xxx&all=true 清空所有评论
export async function DELETE(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get('cwd');
  const id = request.nextUrl.searchParams.get('id');
  const all = request.nextUrl.searchParams.get('all');

  if (!cwd) {
    return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    const dataPath = getCommentsFilePath(cwd);

    // 清空所有评论
    if (all === 'true') {
      await writeJsonFile(dataPath, { comments: [] });
      return NextResponse.json({ success: true });
    }

    // 删除单个评论
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const data = await readJsonFile<CommentsData>(dataPath, { comments: [] });

    const commentIndex = data.comments.findIndex(c => c.id === id);
    if (commentIndex === -1) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    data.comments.splice(commentIndex, 1);
    await writeJsonFile(dataPath, data);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting comment:', error);
    return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 });
  }
}
