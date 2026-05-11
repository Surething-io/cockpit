import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { getReviewFilePath, readJsonFile, writeJsonFile, withFileLock } from '@cockpit/shared-utils';
import { ReviewData } from '../lib/reviewUtils';

type RouteParams = { params: Promise<{ id: string }> };

// GET - Fetch the full data for a single review
export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;

  try {
    const filePath = getReviewFilePath(id);
    if (!existsSync(filePath)) {
      return Response.json({ error: 'Review not found' }, { status: 404 });
    }

    const review = await readJsonFile<ReviewData>(filePath, null as unknown as ReviewData);
    if (!review) {
      return Response.json({ error: 'Review not found' }, { status: 404 });
    }

    return Response.json({ review });
  } catch (error) {
    console.error('Error reading review:', error);
    return Response.json({ error: 'Failed to read review' }, { status: 500 });
  }
}

// PUT - Update a review (toggle active, update title)
// body: { active?, title? }
export async function PUT(request: Request, { params }: RouteParams) {
  const { id } = await params;

  try {
    const filePath = getReviewFilePath(id);
    if (!existsSync(filePath)) {
      return Response.json({ error: 'Review not found' }, { status: 404 });
    }

    const body = await request.json();

    const updated = await withFileLock(filePath, async () => {
      const review = await readJsonFile<ReviewData>(filePath, null as unknown as ReviewData);
      if (!review) throw new Error('Review not found');

      if (body.active !== undefined) review.active = body.active;
      if (body.title !== undefined) review.title = body.title;

      await writeJsonFile(filePath, review);
      return review;
    });

    return Response.json({ review: { id: updated.id, title: updated.title, active: updated.active } });
  } catch (error) {
    console.error('Error updating review:', error);
    return Response.json({ error: 'Failed to update review' }, { status: 500 });
  }
}

// DELETE - Delete a review
export async function DELETE(_request: Request, { params }: RouteParams) {
  const { id } = await params;

  try {
    const filePath = getReviewFilePath(id);
    if (!existsSync(filePath)) {
      return Response.json({ error: 'Review not found' }, { status: 404 });
    }

    await unlink(filePath);
    return Response.json({ success: true });
  } catch (error) {
    console.error('Error deleting review:', error);
    return Response.json({ error: 'Failed to delete review' }, { status: 500 });
  }
}
