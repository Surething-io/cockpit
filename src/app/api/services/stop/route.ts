import { NextRequest, NextResponse } from 'next/server';
import { serviceManager } from '@/lib/serviceManager';

export async function POST(request: NextRequest) {
  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json(
        { error: 'Missing service id' },
        { status: 400 }
      );
    }

    const success = serviceManager.stop(id);

    if (!success) {
      return NextResponse.json(
        { error: 'Service not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to stop service:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to stop service' },
      { status: 500 }
    );
  }
}
