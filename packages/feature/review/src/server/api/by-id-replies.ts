import { existsSync } from 'fs';
import { getReviewFilePath, readJsonFile, writeJsonFile, withFileLock, notifyReviewChange } from '@cockpit/shared-utils';
import { ReviewData, generateReplyId } from '../lib/reviewUtils';

type RouteParams = { params: Promise<{ id: string }> };

// POST - Add a reply
// body: { commentId, author, authorId, content }
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;

  try {
    const filePath = getReviewFilePath(id);
    if (!existsSync(filePath)) {
      return Response.json({ error: 'Review not found' }, { status: 404 });
    }

    const body = await request.json();
    const { commentId, author, authorId, content } = body;

    if (!commentId || !author || !authorId || !content) {
      return Response.json(
        { error: 'commentId, author, authorId, and content are required' },
        { status: 400 }
      );
    }

    const reply = await withFileLock(filePath, async () => {
      const review = await readJsonFile<ReviewData>(filePath, null as unknown as ReviewData);
      if (!review) throw new Error('Review not found');

      const comment = review.comments.find(c => c.id === commentId);
      if (!comment) throw new Error('Comment not found');

      const newReply = {
        id: generateReplyId(),
        author,
        authorId,
        content,
        createdAt: Date.now(),
      };

      comment.replies.push(newReply);
      await writeJsonFile(filePath, review);
      return newReply;
    });

    notifyReviewChange();
    return Response.json({ reply });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to add reply';
    const status = msg === 'Comment not found' ? 404 : 500;
    return Response.json({ error: msg }, { status });
  }
}

// PATCH - Edit a reply
// body: { commentId, replyId, content }
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;

  try {
    const filePath = getReviewFilePath(id);
    if (!existsSync(filePath)) {
      return Response.json({ error: 'Review not found' }, { status: 404 });
    }

    const body = await request.json();
    const { commentId, replyId, content } = body;

    if (!commentId || !replyId || !content) {
      return Response.json({ error: 'commentId, replyId and content are required' }, { status: 400 });
    }

    const updated = await withFileLock(filePath, async () => {
      const review = await readJsonFile<ReviewData>(filePath, null as unknown as ReviewData);
      if (!review) throw new Error('Review not found');

      const comment = review.comments.find(c => c.id === commentId);
      if (!comment) throw new Error('Comment not found');

      const reply = comment.replies.find(r => r.id === replyId);
      if (!reply) throw new Error('Reply not found');

      reply.content = content.trim();
      reply.edited = true;
      await writeJsonFile(filePath, review);
      return reply;
    });

    notifyReviewChange();
    return Response.json({ reply: updated });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to edit reply';
    const status = ['Comment not found', 'Reply not found'].includes(msg) ? 404 : 500;
    return Response.json({ error: msg }, { status });
  }
}

// DELETE - Delete a reply
// ?commentId=xxx&replyId=xxx
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const commentId = new URL(request.url).searchParams.get('commentId');
  const replyId = new URL(request.url).searchParams.get('replyId');

  if (!commentId || !replyId) {
    return Response.json({ error: 'commentId and replyId are required' }, { status: 400 });
  }

  try {
    const filePath = getReviewFilePath(id);
    if (!existsSync(filePath)) {
      return Response.json({ error: 'Review not found' }, { status: 404 });
    }

    await withFileLock(filePath, async () => {
      const review = await readJsonFile<ReviewData>(filePath, null as unknown as ReviewData);
      if (!review) throw new Error('Review not found');

      const comment = review.comments.find(c => c.id === commentId);
      if (!comment) throw new Error('Comment not found');

      const idx = comment.replies.findIndex(r => r.id === replyId);
      if (idx === -1) throw new Error('Reply not found');

      comment.replies.splice(idx, 1);
      await writeJsonFile(filePath, review);
    });

    notifyReviewChange();
    return Response.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to delete reply';
    const status = ['Comment not found', 'Reply not found'].includes(msg) ? 404 : 500;
    return Response.json({ error: msg }, { status });
  }
}
