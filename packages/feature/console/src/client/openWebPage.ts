/**
 * Web pages (http/https, localhost included) open as Chrome tabs, never as
 * Console bubbles: a real tab has the user's logins, is never refused framing,
 * and is what `cockpit browser` drives best. Bubbles are for Cockpit-served
 * content only (local HTML apps, file previews).
 *
 * Opened through the OpenCockpit Bridge extension (lands in the "Cockpit" tab
 * group, already allowed, with a short id); without the extension it falls
 * back to a plain new tab.
 */
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { toast } from '@cockpit/shared-ui';
import i18n from '@cockpit/shared-i18n';
import { openUrlInBrowserTab } from './effect/browserBubbleClient';

export function isWebUrl(input: string): boolean {
  const t = input.trim().toLowerCase();
  return t.startsWith('http://') || t.startsWith('https://');
}

export async function openWebPage(url: string, cwd?: string): Promise<void> {
  const exit = await BrowserRuntime.runPromiseExit(openUrlInBrowserTab(url.trim(), cwd, true));
  if (exit._tag === 'Success') {
    const { shortId, cli } = exit.value;
    toast(i18n.t('browser.openedInChrome', { command: `${cli || 'cockpit'} browser ${shortId}` }));
    return;
  }
  window.open(url.trim(), '_blank', 'noopener');
  toast(i18n.t('browser.openInTabFallback'));
}
