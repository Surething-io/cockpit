import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { isMac, isWindows } from '@/lib/platform';

/**
 * GET /api/pick-folder
 * Open the native system folder picker dialog and return the selected absolute path
 */
export async function GET() {
  try {
    const home = homedir();
    let result: string;

    if (isMac) {
      // macOS: osascript
      const script = `osascript -e 'POSIX path of (choose folder with prompt "选择项目文件夹" default location POSIX file "${home}")'`;
      result = execSync(script, { encoding: 'utf8', timeout: 60000 }).trim();
    } else if (isWindows) {
      // Windows: PowerShell FolderBrowserDialog
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.SelectedPath = '${home}'; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}`;
      result = execSync(`powershell -Command "${ps}"`, { encoding: 'utf8', timeout: 60000 }).trim();
    } else {
      // Linux: zenity, fallback to kdialog
      try {
        result = execSync(`zenity --file-selection --directory --title="选择项目文件夹" 2>/dev/null`, { encoding: 'utf8', timeout: 60000 }).trim();
      } catch {
        result = execSync(`kdialog --getexistingdirectory "${home}" --title "选择项目文件夹" 2>/dev/null`, { encoding: 'utf8', timeout: 60000 }).trim();
      }
    }

    if (result) {
      // Strip trailing slash
      const folder = result.replace(/[/\\]$/, '');
      return NextResponse.json({ folder });
    }

    return NextResponse.json({ folder: null });
  } catch {
    // User cancelled, or the command is unavailable
    return NextResponse.json({ folder: null });
  }
}
