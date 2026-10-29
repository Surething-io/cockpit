import { describe, expect, it } from 'vitest';
import { isTerminalReport } from './TerminalWsManager';

describe('isTerminalReport', () => {
  it('recognizes the replies xterm emits on its own', () => {
    expect(isTerminalReport('\x1b[12;40R')).toBe(true); // cursor position report
    expect(isTerminalReport('\x1b[?1;2c')).toBe(true); // primary device attributes
    expect(isTerminalReport('\x1b[>0;276;0c')).toBe(true); // secondary device attributes
    expect(isTerminalReport('\x1b]11;rgb:1e1e/1e1e/1e1e\x07')).toBe(true); // OSC colour, BEL
    expect(isTerminalReport('\x1b]10;rgb:ffff/ffff/ffff\x1b\\')).toBe(true); // OSC colour, ST
  });

  it('lets real keystrokes through', () => {
    for (const key of ['a', 'ls -la\r', '\r', '\x7f', '\x03', '\x1b', '\x1b[A', '\x1b[B', '\x1b[1;5C', '\t']) {
      expect(isTerminalReport(key)).toBe(false);
    }
  });
});
