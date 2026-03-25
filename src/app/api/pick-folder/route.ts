import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { isMac, isWindows } from '@/lib/platform';
import { SETTINGS_FILE, readJsonFile } from '@/lib/paths';
import en from '@/locales/en.json';
import zh from '@/locales/zh.json';

const locales: Record<string, typeof en> = { en, zh };

/**
 * GET /api/pick-folder
 * Read language from ~/.cockpit/settings.json, open the native folder picker
 */
export async function GET() {
  try {
    const settings = await readJsonFile<{ language?: string }>(SETTINGS_FILE, {});
    const locale = (settings.language === 'en' || settings.language === 'zh') ? settings.language : 'en';
    const messages = locales[locale];
    const prompt = messages.api.pickFolderPrompt;
    const home = homedir();
    let result: string;

    if (isMac) {
      const script = `osascript -e 'POSIX path of (choose folder with prompt "${prompt}" default location POSIX file "${home}")'`;
      result = execSync(script, { encoding: 'utf8', timeout: 60000 }).trim();
    } else if (isWindows) {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.SelectedPath = '${home}'; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}`;
      result = execSync(`powershell -Command "${ps}"`, { encoding: 'utf8', timeout: 60000 }).trim();
    } else {
      try {
        result = execSync(`zenity --file-selection --directory --title="${prompt}" 2>/dev/null`, { encoding: 'utf8', timeout: 60000 }).trim();
      } catch {
        result = execSync(`kdialog --getexistingdirectory "${home}" --title "${prompt}" 2>/dev/null`, { encoding: 'utf8', timeout: 60000 }).trim();
      }
    }

    if (result) {
      const folder = result.replace(/[/\\]$/, '');
      return NextResponse.json({ folder });
    }

    return NextResponse.json({ folder: null });
  } catch {
    return NextResponse.json({ folder: null });
  }
}
