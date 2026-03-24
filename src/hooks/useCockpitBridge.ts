'use client';

import { useSyncExternalStore } from 'react';

/**
 * The Chrome extension's content script (isolated world) injects into <head>:
 *   <meta name="cockpit-bridge" data-id="xxx" data-version="1.0.1">
 *
 * The DOM is shared, so the page can read it. Does not modify <html> attributes and does not trigger hydration mismatches.
 */

interface CockpitBridge {
  id: string;
  version: string;
}

// ---------- Read from DOM ----------

function readFromDom(): CockpitBridge | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector('meta[name="cockpit-bridge"]') as HTMLMetaElement | null;
  if (!meta) return null;
  const id = meta.dataset.id;
  const version = meta.dataset.version;
  return id ? { id, version: version || 'unknown' } : null;
}

// ---------- External store (singleton, shared across all components) ----------

let snapshot: CockpitBridge | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);

  // Attempt a DOM refresh on every new subscription (handles delayed meta tag insertion)
  const current = readFromDom();
  if (current && !snapshot) {
    snapshot = current;
    // Notify on the next microtask to avoid synchronous dispatch inside subscribe
    Promise.resolve().then(notify);
  }

  return () => { listeners.delete(cb); };
}

function getSnapshot() { return snapshot; }
function getServerSnapshot() { return null; }

// Initial read
if (typeof document !== 'undefined') {
  snapshot = readFromDom();
}

// Watch for child node changes in <head> to detect dynamically inserted meta tags
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  const observer = new MutationObserver(() => {
    const current = readFromDom();
    if (current && (!snapshot || current.id !== snapshot.id || current.version !== snapshot.version)) {
      snapshot = current;
      notify();
    }
  });
  // content script inserts into head or documentElement
  const target = document.head || document.documentElement;
  if (target) {
    observer.observe(target, { childList: true });
  }
}

// ---------- Hook ----------

export function useCockpitBridge(): CockpitBridge | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ---------- Imperative API (for non-React code) ----------

export function getCockpitBridge(): CockpitBridge | null {
  // Prefer cached value; fall back to reading DOM live
  return snapshot ?? readFromDom();
}
