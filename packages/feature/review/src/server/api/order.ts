import { join } from 'path';
import { REVIEW_DIR, writeJsonFile, ensureDir } from '@cockpit/shared-utils';

const ORDER_FILE = join(REVIEW_DIR, '_order.json');

// PUT - Save sort order
// body: { order: string[] }
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { order } = body;

    if (!Array.isArray(order)) {
      return Response.json({ error: 'order must be an array' }, { status: 400 });
    }

    await ensureDir(REVIEW_DIR);
    await writeJsonFile(ORDER_FILE, order);

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error saving review order:', error);
    return Response.json({ error: 'Failed to save order' }, { status: 500 });
  }
}
