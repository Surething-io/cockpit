import { NextRequest, NextResponse } from 'next/server';
import { serviceManager } from '@/lib/serviceManager';

export async function POST(request: NextRequest) {
  try {
    const { cwd, command } = await request.json();

    if (!cwd || !command) {
      return NextResponse.json(
        { error: 'Missing cwd or command' },
        { status: 400 }
      );
    }

    const service = await serviceManager.start(cwd, command);
    return NextResponse.json(service);
  } catch (error) {
    console.error('Failed to start service:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start service' },
      { status: 500 }
    );
  }
}
