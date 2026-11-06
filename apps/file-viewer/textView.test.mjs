import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import { isFileViewerPath, toFileViewerUrl } from '../../packages/shared/utils/src/htmlBashSdk';

const source = readFileSync(new URL('./app.jsx', import.meta.url), 'utf8');
const { code } = transformSync(source, { loader: 'jsx', jsx: 'transform' });

// Exercise the shipped app's dispatch and rendering with only disk IO replaced.
// This does not cover effects, the SDK connection, or browser layout.
function renderViewer(path, readState) {
  let root;
  const url = toFileViewerUrl(path, '/project');
  const context = vm.createContext({
    React,
    ReactDOM: { createRoot: () => ({ render: (element) => { root = element; } }) },
    document: { getElementById: () => ({}) },
    location: { search: url.slice(url.indexOf('?')) },
    URLSearchParams,
    readState,
  });
  vm.runInContext(code + '\nuseAsync = () => readState;', context);
  return renderToStaticMarkup(root);
}

describe('text file preview', () => {
  it('routes a Console TXT path to a literal text view, preserving markup and whitespace', () => {
    const path = '/project/notes/review instructions.TXT';
    const content = '# Heading\n  **literal**\n<script>alert(1)</script>\n';
    expect(isFileViewerPath(path)).toBe(true);
    const html = renderViewer(path, { loading: false, data: content, error: null });
    expect(html).toBe('<pre class="text-view"># Heading\n  **literal**\n&lt;script&gt;alert(1)&lt;/script&gt;\n</pre>');
  });

  it('shows an empty TXT file without reporting an unsupported type', () => {
    expect(renderViewer('empty.txt', { loading: false, data: '', error: null }))
      .toBe('<pre class="text-view"></pre>');
  });

  it.each(['/tmp/cockpit-codex-review.APElEH', '/tmp/README', '/tmp/code.ts', '/tmp/source.html'])('shows %s as literal text', (path) => {
    expect(renderViewer(path, { loading: false, data: '<h1>literal</h1>', error: null }))
      .toBe('<pre class="text-view">&lt;h1&gt;literal&lt;/h1&gt;</pre>');
  });

  it('surfaces a read failure instead of presenting an empty document', () => {
    expect(renderViewer('missing.txt', { loading: false, data: null, error: 'No such file' }))
      .toContain('file-viewer: /project/missing.txt\n\nNo such file');
  });

  it('keeps HTML outside the document viewer routing', () => {
    expect(isFileViewerPath('/project/unreviewed.html')).toBe(false);
  });

  it.each(['README', 'guide.md', 'table.csv', 'data.json', 'picture.png', 'document.pdf'])('resolves ~/ paths before dispatching %s', (name) => {
    const context = vm.createContext({
      React: { ...React, useEffect() {} },
      ReactDOM: { createRoot: () => ({ render() {} }) },
      document: { getElementById: () => null },
      location: { search: '?file=' + encodeURIComponent('~/notes/' + name) },
      URLSearchParams,
      cockpit: { cwd: '/resolved/home/notes' },
    });
    vm.runInContext(code + '\nglobalThis.selectedView = App();', context);
    expect(context.selectedView.props.file).toBe('/resolved/home/notes/' + name);
  });
});
