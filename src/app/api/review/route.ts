import { NextRequest, NextResponse } from 'next/server';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { REVIEW_DIR, getReviewFilePath, readJsonFile, writeJsonFile, ensureDir } from '@/lib/paths';
import { generateReviewId, ReviewData } from '@/lib/review-utils';

const ORDER_FILE = join(REVIEW_DIR, '_order.json');

// GET - 列出所有 review（返回摘要，不含完整 content）
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
      commentCount: number;
      sourceFile?: string;
    }> = [];

    for (const file of jsonFiles) {
      const id = file.replace('.json', '');
      const data = await readJsonFile<ReviewData>(getReviewFilePath(id), null as unknown as ReviewData);
      if (data) {
        reviews.push({
          id: data.id,
          title: data.title,
          active: data.active,
          createdAt: data.createdAt,
          commentCount: data.comments.length,
          sourceFile: data.sourceFile,
        });
      }
    }

    // 按 order 文件排序，不在 order 里的按创建时间追加到末尾
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

// POST - 创建 review（同一文件复用已有 review）
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
      // 已有 review：更新快照内容和标题，保留评论
      existing.content = content;
      existing.title = title;
      await writeJsonFile(filePath, existing);
      return NextResponse.json({ review: { id: existing.id, title: existing.title, active: existing.active, createdAt: existing.createdAt, existing: true } });
    }

    const review: ReviewData = {
      id,
      title,
      content,
      sourceFile,
      active: true,
      createdAt: Date.now(),
      comments: [],
    };

    await writeJsonFile(filePath, review);

    return NextResponse.json({ review: { id, title, active: true, createdAt: review.createdAt } });
  } catch (error) {
    console.error('Error creating review:', error);
    return NextResponse.json({ error: 'Failed to create review' }, { status: 500 });
  }
}
