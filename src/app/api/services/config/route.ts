import { getServicesConfigPath, getGlobalServicesConfigPath, readJsonFile, writeJsonFile } from '@cockpit/shared-utils';

export interface CustomCommand {
  name: string;
  command: string;
}

interface ServicesConfig {
  customCommands: CustomCommand[];
}

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const cwd = searchParams.get('cwd');
    const scope = searchParams.get('scope'); // 'global' for global commands

    const configPath = scope === 'global'
      ? getGlobalServicesConfigPath()
      : cwd
        ? getServicesConfigPath(cwd)
        : null;

    if (!configPath) {
      return Response.json(
        { error: 'Missing cwd or scope' },
        { status: 400 }
      );
    }

    const config = await readJsonFile<ServicesConfig>(configPath, { customCommands: [] });

    return Response.json(config);
  } catch (error) {
    console.error('Failed to read services config:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to read config' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { cwd, scope, customCommands } = await request.json();

    const configPath = scope === 'global'
      ? getGlobalServicesConfigPath()
      : cwd
        ? getServicesConfigPath(cwd)
        : null;

    if (!configPath) {
      return Response.json(
        { error: 'Missing cwd or scope' },
        { status: 400 }
      );
    }

    const config: ServicesConfig = { customCommands: customCommands || [] };
    await writeJsonFile(configPath, config);

    return Response.json({ success: true });
  } catch (error) {
    console.error('Failed to write services config:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to write config' },
      { status: 500 }
    );
  }
}
