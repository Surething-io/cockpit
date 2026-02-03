import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { serviceManager } from '@/lib/serviceManager';
import { getServiceLogPath } from '@/lib/paths';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const id = searchParams.get('id');
    const cwd = searchParams.get('cwd');
    const command = searchParams.get('command');

    let logFile: string;

    // Try to get log file from running service by ID
    if (id) {
      const service = serviceManager.get(id);
      if (service) {
        logFile = service.logFile;
      } else if (cwd && command) {
        // Service stopped, but we have cwd + command to construct log path
        const commandHash = createHash('md5').update(command).digest('hex').slice(0, 8);
        logFile = getServiceLogPath(cwd, commandHash);
      } else {
        return NextResponse.json(
          { error: 'Service not found and missing cwd/command for historical log' },
          { status: 404 }
        );
      }
    } else if (cwd && command) {
      // Direct access to historical log by cwd + command
      const commandHash = createHash('md5').update(command).digest('hex').slice(0, 8);
      logFile = getServiceLogPath(cwd, commandHash);
    } else {
      return NextResponse.json(
        { error: 'Missing required parameters: id or (cwd + command)' },
        { status: 400 }
      );
    }

    // Check if log file exists
    if (!existsSync(logFile)) {
      return NextResponse.json({ content: '' });
    }

    // Read log file
    const content = await readFile(logFile, 'utf-8');
    return NextResponse.json({ content });
  } catch (error) {
    console.error('Failed to read log:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read log' },
      { status: 500 }
    );
  }
}
