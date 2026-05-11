import { getCommentsFilePath, readJsonFile, writeJsonFile } from '@cockpit/shared-utils';

export interface CodeComment {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  selectedText?: string; // Selected original text (for scenarios without a real file, e.g. AI message bubbles)
  createdAt: number;
  updatedAt?: number;
}

interface CommentsData {
  comments: CodeComment[];
}

// GET - Retrieve file comments
// ?cwd=xxx&filePath=xxx (filePath optional; omit to return all)
export async function GET(request: Request) {
  const cwd = new URL(request.url).searchParams.get('cwd');
  const filePath = new URL(request.url).searchParams.get('filePath');

  if (!cwd) {
    return Response.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    const dataPath = getCommentsFilePath(cwd);
    const data = await readJsonFile<CommentsData>(dataPath, { comments: [] });

    // If filePath is specified, return only comments for that file
    if (filePath) {
      const fileComments = data.comments.filter(c => c.filePath === filePath);
      return Response.json({ comments: fileComments });
    }

    return Response.json(data);
  } catch (error) {
    console.error('Error reading comments:', error);
    return Response.json({ error: 'Failed to read comments' }, { status: 500 });
  }
}

// POST - Add comment
// body: { cwd, filePath, startLine, endLine, content }
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { cwd, filePath, startLine, endLine, content, selectedText } = body;

    if (!cwd || !filePath || startLine === undefined || endLine === undefined || content === undefined) {
      return Response.json(
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
      ...(selectedText ? { selectedText } : {}),
      createdAt: Date.now(),
    };

    data.comments.push(newComment);
    await writeJsonFile(dataPath, data);

    return Response.json({ comment: newComment });
  } catch (error) {
    console.error('Error adding comment:', error);
    return Response.json({ error: 'Failed to add comment' }, { status: 500 });
  }
}

// PUT - Update comment
// body: { cwd, id, content }
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { cwd, id, content } = body;

    if (!cwd || !id || content === undefined) {
      return Response.json(
        { error: 'cwd, id, and content are required' },
        { status: 400 }
      );
    }

    const dataPath = getCommentsFilePath(cwd);
    const data = await readJsonFile<CommentsData>(dataPath, { comments: [] });

    const commentIndex = data.comments.findIndex(c => c.id === id);
    if (commentIndex === -1) {
      return Response.json({ error: 'Comment not found' }, { status: 404 });
    }

    data.comments[commentIndex] = {
      ...data.comments[commentIndex],
      content,
      updatedAt: Date.now(),
    };

    await writeJsonFile(dataPath, data);

    return Response.json({ comment: data.comments[commentIndex] });
  } catch (error) {
    console.error('Error updating comment:', error);
    return Response.json({ error: 'Failed to update comment' }, { status: 500 });
  }
}

// DELETE - Delete comment
// ?cwd=xxx&id=xxx deletes a single comment
// ?cwd=xxx&all=true clears all comments
export async function DELETE(request: Request) {
  const cwd = new URL(request.url).searchParams.get('cwd');
  const id = new URL(request.url).searchParams.get('id');
  const all = new URL(request.url).searchParams.get('all');

  if (!cwd) {
    return Response.json({ error: 'cwd is required' }, { status: 400 });
  }

  try {
    const dataPath = getCommentsFilePath(cwd);

    // Clear all comments
    if (all === 'true') {
      await writeJsonFile(dataPath, { comments: [] });
      return Response.json({ success: true });
    }

    // Delete single comment
    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }

    const data = await readJsonFile<CommentsData>(dataPath, { comments: [] });

    const commentIndex = data.comments.findIndex(c => c.id === id);
    if (commentIndex === -1) {
      return Response.json({ error: 'Comment not found' }, { status: 404 });
    }

    data.comments.splice(commentIndex, 1);
    await writeJsonFile(dataPath, data);

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error deleting comment:', error);
    return Response.json({ error: 'Failed to delete comment' }, { status: 500 });
  }
}
