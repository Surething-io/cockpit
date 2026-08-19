/**
 * Standalone entry for /html-lib/csv-viewer.js — `window.CockpitCsv`.
 *
 * Bundled SELF-CONTAINED (own React copy, built by scripts/build-html-lib.mjs)
 * so html apps — including the built-in file-viewer the console bubble opens —
 * get the same CSV/TSV table the Explorer and chat previews render:
 * RFC 4180 parsing (quoted delimiters, `""` escapes, embedded newlines),
 * sticky header + row numbers, chunked rows. Imperative widget API, same
 * rationale as CockpitMarkdown / CockpitJson / CockpitPdf.
 *
 *   CockpitCsv.render(el, csvText, { filePath })   // mount or update in place
 *   CockpitCsv.unmount(el)                         // dispose
 *
 * `filePath` only decides the delimiter default (`.tsv` → tab); content is
 * passed in, so the widget never touches the filesystem — the host app reads
 * the file through cockpit.bash like any user app.
 *
 * Requires /html-lib/csv-viewer.css (utilities) and /html-lib/theme.css
 * (semantic color vars) on the page; light/dark follows the `dark` class on
 * <html> through those vars, with no re-render.
 *
 * i18n: ships its OWN en/zh microcopy inline on a bundle-private i18next
 * instance (cockpit's global dictionary never enters the bundle); the host only
 * signals the LANGUAGE via <html data-cockpit-lang> + the
 * `cockpit:language-change` broadcast. Same contract as cockpitJson.
 */
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { CsvTableView } from '../client/CsvTableView';

const LABELS = {
  en: {
    table: 'Table',
    raw: 'Raw',
    empty: 'Empty table',
    summary: '{{rows}} rows · {{cols}} columns',
    loadMore: 'Load more ({{shown}} / {{total}} shown)',
  },
  zh: {
    table: '表格',
    raw: '原始内容',
    empty: '空表格',
    summary: '{{rows}} 行 · {{cols}} 列',
    loadMore: '加载更多（已显示 {{shown}} / {{total}}）',
  },
} as const;

if (!i18n.isInitialized) {
  i18n.init({
    resources: {
      en: { translation: { csv: LABELS.en } },
      zh: { translation: { csv: LABELS.zh } },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
}

i18n.changeLanguage(
  document.documentElement.getAttribute('data-cockpit-lang') ||
    (navigator.language.startsWith('zh') ? 'zh' : 'en')
);
window.addEventListener('message', (e) => {
  if (e.data?.type === 'cockpit:language-change' && e.data.lang) {
    if (i18n.language !== e.data.lang) i18n.changeLanguage(e.data.lang);
  }
});

const mounts = new Map<Element, Root>();

function render(el: Element, csvText: string, opts: { filePath?: string } = {}) {
  let root = mounts.get(el);
  if (!root) {
    root = createRoot(el);
    mounts.set(el, root);
  }
  root.render(
    <I18nextProvider i18n={i18n}>
      <div className="cockpit-csv" style={{ height: '100%' }}>
        <CsvTableView content={csvText} filePath={opts.filePath} className="h-full" />
      </div>
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
    CockpitCsv: { render: typeof render; unmount: typeof unmount };
  }
}

window.CockpitCsv = { render, unmount };
