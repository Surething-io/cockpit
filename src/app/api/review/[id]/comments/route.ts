import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'fs';
import { getReviewFilePath, readJsonFile, writeJsonFile, withFileLock, notifyReviewChange } from '@/lib/paths';
import { ReviewData, generateCommentId } from '@/lib/review-utils';

type RouteParams = { params: Promise<{ id: string }> };

// POST - Add a comment
// body: { author, authorId, content, anchor: { startOffset, endOffset, selectedText } }
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  try {
    const filePath = getReviewFilePath(id);
    if (!existsSync(filePath)) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    const body = await request.json();
    const { author, authorId, content, anchor } = body;

    if (!author || !authorId || !content || !anchor) {
      return NextResponse.json(
        { error: 'author, authorId, content, and anchor are required' },
        { status: 400 }
      );
    }

    const comment = await withFileLock(filePath, async () => {
      const review = await readJsonFile<ReviewData>(filePath, null as unknown as ReviewData);
      if (!review) throw new Error('Review not found');

      const newComment = {
        id: generateCommentId(),
        author,
        authorId,
        content,
        anchor,
        createdAt: Date.now(),
        replies: [],
      };

      review.comments.push(newComment);
      await writeJsonFile(filePath, review);
      return newComment;
    });

    notifyReviewChange();
    return NextResponse.json({ comment });
  } catch (error) {
    console.error('Error adding comment:', error);
    return NextResponse.json({ error: 'Failed to add comment' }, { status: 500 });
  }
}

// PATCH - Edit comment content or toggle closed state
// body: { commentId, content } or { commentId, closed }
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  try {
    const filePath = getReviewFilePath(id);
    if (!existsSync(filePath)) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    const body = await request.json();
    const { commentId, content, closed } = body;

    if (!commentId || (content === undefined && closed === undefined)) {
      return NextResponse.json({ error: 'commentId and (content or closed) are required' }, { status: 400 });
    }

    const updated = await withFileLock(filePath, async () => {
      const review = await readJsonFile<ReviewData>(filePath, null as unknown as ReviewData);
      if (!review) throw new Error('Review not found');

      const comment = review.comments.find(c => c.id === commentId);
      if (!comment) throw new Error('Comment not found');

      if (content !== undefined) {
        comment.content = content.trim();
        comment.edited = true;
      }
      if (closed !== undefined) {
        comment.closed = !!closed;
      }
      await writeJsonFile(filePath, review);
      return comment;
    });

    notifyReviewChange();
    return NextResponse.json({ comment: updated });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to edit comment';
    const status = msg === 'Comment not found' ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

// DELETE - Delete a comment
// ?commentId=xxx
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const commentId = request.nextUrl.searchParams.get('commentId');

  if (!commentId) {
    return NextResponse.json({ error: 'commentId is required' }, { status: 400 });
  }

  try {
    const filePath = getReviewFilePath(id);
    if (!existsSync(filePath)) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    await withFileLock(filePath, async () => {
      const review = await readJsonFile<ReviewData>(filePath, null as unknown as ReviewData);
      if (!review) throw new Error('Review not found');

      const idx = review.comments.findIndex(c => c.id === commentId);
      if (idx === -1) throw new Error('Comment not found');

      review.comments.splice(idx, 1);
      await writeJsonFile(filePath, review);
    });

    notifyReviewChange();
    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to delete comment';
    const status = msg === 'Comment not found' ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
