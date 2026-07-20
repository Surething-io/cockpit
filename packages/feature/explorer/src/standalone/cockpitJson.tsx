/**
 * Standalone entry for /html-lib/json-viewer.js — `window.CockpitJson`.
 *
 * Bundled SELF-CONTAINED (own React copy, built by scripts/build-html-lib.mjs)
 * so html apps get the same human-readable JSON view the Explorer's "readable"
 * toggle (and the agent tool-call previews) use: colorized keys/values via the
 * theme-aware palette, `\n` in string values unescaped to real newlines, long
 * strings click-to-collapse. Imperative widget API, same rationale as
 * CockpitMarkdown / CockpitPdf.
 *
 *   CockpitJson.render(el, jsonText, opts?)   // mount or update in place
 *   CockpitJson.unmount(el)                   // dispose
 *
 *   opts = { labels?: { en?: { foldedLines }, zh?: { foldedLines } } }
 *          // override the built-in fold-hint microcopy ({{count}} interpolated)
 *
 * Invalid JSON renders as the raw text. Colors come from THEME_JSON_COLORS
 * (Radix *-11 CSS vars served by /html-lib/theme.css), so light/dark follows
 * the `dark` class on <html> with no re-render. The host page provides the
 * pre-like container styling (font-mono, pre-wrap, scroll).
 *
 * i18n: the widget ships its OWN default en/zh microcopy inline (below) on a
 * bundle-private i18next instance — cockpit's global dictionary is not
 * involved (the build aliases `@cockpit/shared-i18n` → `i18next`, so
 * toolCallUtils resolves to this same instance). The host app only signals
 * the LANGUAGE TYPE (navigator guess + `cockpit:language-change` broadcast).
 */
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { formatAsHumanReadable, THEME_JSON_COLORS } from '../client/toolCallUtils';

interface JsonLabels {
  foldedLines?: string;
}

// The widget's own microcopy — the only strings this bundle ships.
const DEFAULT_LABELS: Record<'en' | 'zh', Required<JsonLabels>> = {
  en: { foldedLines: '... ({{count}} lines)' },
  zh: { foldedLines: '... ({{count}} 行)' },
};

if (!i18n.isInitialized) {
  i18n.init({
    resources: {
      en: { translation: { toolCall: DEFAULT_LABELS.en } },
      zh: { translation: { toolCall: DEFAULT_LABELS.zh } },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
}

// Same language handling as cockpitMarkdown: navigator guess + host broadcast.
// (The folded-lines hint inside CollapsibleEntry goes through i18n.t directly,
// but wrap with the Provider anyway so any hook-based consumer works too.)
i18n.changeLanguage(navigator.language.startsWith('zh') ? 'zh' : 'en');
window.addEventListener('message', (e) => {
  if (e.data?.type === 'cockpit:language-change' && e.data.lang) {
    if (i18n.language !== e.data.lang) i18n.changeLanguage(e.data.lang);
  }
});

interface RenderOpts {
  labels?: Partial<Record<'en' | 'zh', JsonLabels>>;
}

const mounts = new Map<Element, Root>();

function render(el: Element, jsonText: string, opts: RenderOpts = {}) {
  if (opts.labels) {
    for (const lang of ['en', 'zh'] as const) {
      if (opts.labels[lang]) {
        i18n.addResourceBundle(lang, 'translation', { toolCall: opts.labels[lang] }, true, true);
      }
    }
  }
  let root = mounts.get(el);
  if (!root) {
    root = createRoot(el);
    mounts.set(el, root);
  }
  root.render(
    <I18nextProvider i18n={i18n}>
      {formatAsHumanReadable(jsonText, THEME_JSON_COLORS)}
    </I18nextProvider>,
  );
}

function unmount(el: Element) {
  const root = mounts.get(el);
  if (!root) return;
  root.unmount();
  mounts.delete(el);
}

declare global {
  interface Window {
    CockpitJson: { render: typeof render; unmount: typeof unmount };
  }
}

window.CockpitJson = { render, unmount };
