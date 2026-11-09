import type { ChatMessage } from './types';

// Message fields are JSON data. Compare nested render state as well as text,
// retaining references for unchanged bubbles without depending on object key order.
function sameMessageValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameMessageValue(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameMessageValue(left[key], right[key]));
}

/** Reuse equal rendered records without deciding window or run ownership. */
export function reuseMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(previous.map((message) => [message.id, message]));
  const next = incoming.map((message) => {
    const before = byId.get(message.id);
    return before && sameMessageValue(before, message) ? before : message;
  });
  return next.length === previous.length && next.every((message, index) => message === previous[index]) ? previous : next;
}
