import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';

export async function POST(request: NextRequest) {
  try {
    const { cwd } = await request.json();

    if (!cwd) {
      return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
    }

    // Run the code command to open the directory
    exec(`code "${cwd}"`, (error) => {
      if (error) {
        console.error('Failed to open VS Code:', error);
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error opening VS Code:', error);
    return NextResponse.json({ error: 'Failed to open VS Code' }, { status: 500 });
  }
}
