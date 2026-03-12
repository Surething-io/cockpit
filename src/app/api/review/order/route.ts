import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { REVIEW_DIR, writeJsonFile, ensureDir } from '@/lib/paths';

const ORDER_FILE = join(REVIEW_DIR, '_order.json');

// PUT - 保存排序
// body: { order: string[] }
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { order } = body;

    if (!Array.isArray(order)) {
      return NextResponse.json({ error: 'order must be an array' }, { status: 400 });
    }

    await ensureDir(REVIEW_DIR);
    await writeJsonFile(ORDER_FILE, order);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving review order:', error);
    return NextResponse.json({ error: 'Failed to save order' }, { status: 500 });
  }
}
