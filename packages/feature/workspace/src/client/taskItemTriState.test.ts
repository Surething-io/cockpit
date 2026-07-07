import { describe, it, expect } from 'vitest';
import { statusToBox, statusFromDom, type TaskStatus } from './taskItemTriState';

describe('statusToBox', () => {
  it('maps each status to its markdown checkbox token', () => {
    expect(statusToBox('todo')).toBe('[ ]');
    expect(statusToBox('doing')).toBe('[/]');
    expect(statusToBox('done')).toBe('[x]');
  });
});

describe('statusFromDom', () => {
  const el = (attrs: Record<string, string>): HTMLElement =>
    ({ getAttribute: (k: string) => (k in attrs ? attrs[k] : null) }) as unknown as HTMLElement;

  it('prefers an explicit data-status', () => {
    (['todo', 'doing', 'done'] as TaskStatus[]).forEach((s) => {
      expect(statusFromDom(el({ 'data-status': s }))).toBe(s);
    });
  });

  it('falls back to legacy data-checked for [ ] / [x] items', () => {
    expect(statusFromDom(el({ 'data-checked': 'true' }))).toBe('done');
    expect(statusFromDom(el({ 'data-checked': '' }))).toBe('done');
    expect(statusFromDom(el({ 'data-checked': 'false' }))).toBe('todo');
    expect(statusFromDom(el({}))).toBe('todo');
  });
});
