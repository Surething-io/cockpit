import { NextRequest, NextResponse } from 'next/server';
import { getServicesConfigPath, readJsonFile, writeJsonFile } from '@/lib/paths';

interface ServicesConfig {
  customCommands: string[];
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const cwd = searchParams.get('cwd');

    if (!cwd) {
      return NextResponse.json(
        { error: 'Missing cwd' },
        { status: 400 }
      );
    }

    const configPath = getServicesConfigPath(cwd);
    const config = await readJsonFile<ServicesConfig>(configPath, { customCommands: [] });

    return NextResponse.json(config);
  } catch (error) {
    console.error('Failed to read services config:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read config' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { cwd, customCommands } = await request.json();

    if (!cwd) {
      return NextResponse.json(
        { error: 'Missing cwd' },
        { status: 400 }
      );
    }

    const configPath = getServicesConfigPath(cwd);
    const config: ServicesConfig = { customCommands: customCommands || [] };
    await writeJsonFile(configPath, config);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to write services config:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to write config' },
      { status: 500 }
    );
  }
}
