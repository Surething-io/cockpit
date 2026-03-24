import { NextRequest, NextResponse } from 'next/server';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { REVIEW_DIR, getReviewFilePath, readJsonFile, writeJsonFile, ensureDir } from '@/lib/paths';
import { generateReviewId, ReviewData } from '@/lib/review-utils';

const ORDER_FILE = join(REVIEW_DIR, '_order.json');

// GET - List all reviews (returns summaries, not the full content)
export async function GET() {
  try {
    await ensureDir(REVIEW_DIR);
    const files = await readdir(REVIEW_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json') && !f.startsWith('_'));

    const reviews: Array<{
      id: string;
      title: string;
      active: boolean;
      createdAt: number;
      updatedAt?: number;
      commentCount: number;
      lastCommentAt?: number;
      sourceFile?: string;
    }> = [];

    for (const file of jsonFiles) {
      const id = file.replace('.json', '');
      const data = await readJsonFile<ReviewData>(getReviewFilePath(id), null as unknown as ReviewData);
      if (data) {
        // Calculate the timestamp of the most recent comment/reply
        let lastCommentAt: number | undefined;
        for (const c of data.comments) {
          if (!lastCommentAt || c.createdAt > lastCommentAt) lastCommentAt = c.createdAt;
          for (const r of c.replies) {
            if (!lastCommentAt || r.createdAt > lastCommentAt) lastCommentAt = r.createdAt;
          }
        }
        reviews.push({
          id: data.id,
          title: data.title,
          active: data.active,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          commentCount: data.comments.length,
          lastCommentAt,
          sourceFile: data.sourceFile,
        });
      }
    }

    // Sort by the order file; append items not in order by creation time
    const order = await readJsonFile<string[]>(ORDER_FILE, []);
    if (order.length > 0) {
      const orderMap = new Map(order.map((id, i) => [id, i]));
      const ordered = reviews.filter(r => orderMap.has(r.id));
      const unordered = reviews.filter(r => !orderMap.has(r.id));
      ordered.sort((a, b) => orderMap.get(a.id)! - orderMap.get(b.id)!);
      unordered.sort((a, b) => b.createdAt - a.createdAt);
      return NextResponse.json({ reviews: [...ordered, ...unordered] });
    }
    reviews.sort((a, b) => b.createdAt - a.createdAt);
    return NextResponse.json({ reviews });
  } catch (error) {
    console.error('Error listing reviews:', error);
    return NextResponse.json({ error: 'Failed to list reviews' }, { status: 500 });
  }
}

// POST - Create a review (reuse existing review for the same file)
// body: { title, content, sourceFile }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, content, sourceFile } = body;

    if (!title || content === undefined || !sourceFile) {
      return NextResponse.json({ error: 'title, content and sourceFile are required' }, { status: 400 });
    }

    await ensureDir(REVIEW_DIR);

    const id = generateReviewId(sourceFile);
    const filePath = getReviewFilePath(id);
    const existing = await readJsonFile<ReviewData>(filePath, null as unknown as ReviewData);

    if (existing) {
      // Existing review: update snapshot content and title, preserve comments, re-activate
      existing.content = content;
      existing.title = title;
      existing.active = true;
      existing.updatedAt = Date.now();
      await writeJsonFile(filePath, existing);
      return NextResponse.json({ review: { id: existing.id, title: existing.title, active: existing.active, createdAt: existing.createdAt, updatedAt: existing.updatedAt, existing: true } });
    }

    const now = Date.now();
    const review: ReviewData = {
      id,
      title,
      content,
      sourceFile,
      active: true,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };

    await writeJsonFile(filePath, review);

    return NextResponse.json({ review: { id, title, active: true, createdAt: review.createdAt, updatedAt: review.updatedAt } });
  } catch (error) {
    console.error('Error creating review:', error);
    return NextResponse.json({ error: 'Failed to create review' }, { status: 500 });
  }
}
