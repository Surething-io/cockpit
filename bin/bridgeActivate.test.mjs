import { describe, it, expect } from 'vitest';
import { activationPlan, wmctrlWindowFor } from './bridgeActivate.mjs';

describe('activationPlan', () => {
  it('macOS opens the app bundle of the parent process', () => {
    expect(activationPlan({ platform: 'darwin', ppid: 1, parentExe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }))
      .toEqual([{ cmd: 'open', args: ['-a', '/Applications/Google Chrome.app'] }]);
    expect(activationPlan({ platform: 'darwin', ppid: 1, parentExe: '/usr/bin/node' })).toEqual([]);
  });

  it('Windows resolves the browser as the launcher\'s parent and lifts the foreground lock', () => {
    const [step] = activationPlan({ platform: 'win32', ppid: 4242 });
    expect(step.cmd).toBe('powershell.exe');
    const script = step.args.at(-1);
    expect(script).toContain('ProcessId=4242');
    expect(script).toContain('$launcher.ParentProcessId');
    expect(script.indexOf('keybd_event(0x12, 0, 0, 0)')).toBeLessThan(script.indexOf('SetForegroundWindow($h)'));
  });

  it('Linux tries xdotool then wmctrl on X11, and nothing on pure Wayland', () => {
    expect(activationPlan({ platform: 'linux', ppid: 7, env: { DISPLAY: ':0' } }).map((s) => s.cmd)).toEqual(['xdotool', 'wmctrl']);
    expect(activationPlan({ platform: 'linux', ppid: 7, env: { WAYLAND_DISPLAY: 'wayland-0' } })).toEqual([]);
  });
});

describe('wmctrlWindowFor', () => {
  it('picks the first window owned by the pid', () => {
    const out = '0x01e00003  0 1234   host Terminal\n0x03a00004  0 7      host Google Chrome\n0x03a00009  0 7      host DevTools\n';
    expect(wmctrlWindowFor(out, 7)).toBe('0x03a00004');
    expect(wmctrlWindowFor(out, 99)).toBeNull();
  });
});
