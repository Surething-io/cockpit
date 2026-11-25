// Raise the browser window that launched the native host.
//
// An extension cannot bring its browser in front of another app (the user is
// usually looking at Cockpit, a terminal or another browser), so the native
// host does it. Each platform gets an ordered list of attempts; the host runs
// them until one succeeds. Every attempt is best-effort: if all fail, the
// extension's `drawAttention` (dock bounce / taskbar flash / urgent hint) is
// what the user gets.
//
//   macOS   — `open -a <app bundle of the parent process>`: reliable.
//   Windows — PowerShell: tap Alt (lifts the foreground lock), restore if
//             minimised, SetForegroundWindow on the browser's main window.
//             The host runs under a .cmd launcher, so the browser is the
//             grandparent; it is resolved inside the script.
//   Linux   — X11 only: xdotool, else wmctrl, matched by the browser's pid.
//             Pure Wayland gives other apps no way to raise a window, so there
//             is nothing to run.

/**
 * @param {{ platform: string, ppid: number, env?: Record<string, string|undefined>, parentExe?: string }} ctx
 *   parentExe — macOS: the parent's executable path (from `ps -o comm=`).
 * @returns {Array<{ cmd: string, args: string[], match?: 'wmctrl' }>}
 */
export function activationPlan({ platform, ppid, env = {}, parentExe = '' }) {
  if (platform === 'darwin') {
    const app = parentExe.match(/^(.*?\.app)\//)?.[1];
    return app ? [{ cmd: 'open', args: ['-a', app] }] : [];
  }

  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '$sig = @"',
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
      '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
      '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);',
      '"@',
      '$w = Add-Type -MemberDefinition $sig -Name Win -Namespace CockpitBridge -PassThru',
      // ppid is the .cmd launcher's cmd.exe; its parent is the browser process.
      `$launcher = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(ppid)}"`,
      '$p = Get-Process -Id $launcher.ParentProcessId',
      'if (-not $p -or $p.MainWindowHandle -eq 0) { exit 1 }',
      '$h = $p.MainWindowHandle',
      'if ($w::IsIconic($h)) { [void]$w::ShowWindow($h, 9) }',
      '$w::keybd_event(0x12, 0, 0, 0)', // Alt down
      '$ok = $w::SetForegroundWindow($h)',
      '$w::keybd_event(0x12, 0, 2, 0)', // Alt up
      'if (-not $ok) { exit 1 }',
    ].join('\n');
    return [{
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    }];
  }

  if (platform === 'linux') {
    if (!env.DISPLAY) return []; // pure Wayland (or headless): no way to raise another app
    return [
      { cmd: 'xdotool', args: ['search', '--onlyvisible', '--pid', String(ppid), 'windowactivate'] },
      { cmd: 'wmctrl', args: ['-lp'], match: 'wmctrl' },
    ];
  }

  return [];
}

/** From `wmctrl -lp` output, the id of the first window owned by `pid`. */
export function wmctrlWindowFor(output, pid) {
  for (const line of String(output).split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 3 && cols[2] === String(pid)) return cols[0];
  }
  return null;
}
