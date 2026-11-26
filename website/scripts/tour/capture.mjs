#!/usr/bin/env node
// Captures the homepage tour frames from the real product.
//
//   1. seeds the fictional demo world (seed.mjs) under /Users/Shared/demo
//   2. starts a scripted stand-in for the Anthropic API (mock-anthropic.mjs) and
//      boots this checkout's production build against the private HOME, with
//      Claude pointed at that stand-in — so sessions really run, in parallel,
//      through the real CLI, with deterministic replies
//   3. drives a Chrome tab through `cockpit browser` (Bridge extension)
//   4. writes public/tour/<id>.webp plus content/tour-frames.json, which holds
//      each frame's focus rect and cursor target as percentages of the frame
//
// Prerequisites: a fresh production build at the repo root
// (`npm run build && npm run build:server`), and the `cockpit` CLI with the
// Bridge extension connected to Chrome. Usage: `npm run tour` in website/.
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { seed } from './seed.mjs';
import { startMockAnthropic } from './mock-anthropic.mjs';
import { parallelSessions } from './parallel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBSITE = join(HERE, '..', '..');
const REPO = join(WEBSITE, '..');
const OUT_DIR = join(WEBSITE, 'public', 'tour');
const DATA_FILE = join(WEBSITE, 'content', 'tour-frames.json');

const ROOT = '/Users/Shared/demo';
const PORT = 3471;
const MOCK_PORT = 3472;
const VIEWPORT = { width: 1600, height: 1000 };
/** Output width of each frame. 2x capture downscaled: sharp on retina, ~100 KB. */
const OUT_WIDTH = 2400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cockpit(...args) {
  return execFileSync('cockpit', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ─────────────────────────────────────────────────────────
// In-page helpers. Everything the tour shows lives in the project iframe;
// rects are reported in top-level viewport pixels.
// ─────────────────────────────────────────────────────────

const PAGE_HELPERS = `
  const frame = [...document.querySelectorAll('iframe')].find((f) => f.offsetParent);
  const d = frame.contentDocument;
  const W = d.defaultView;
  const off = frame.getBoundingClientRect();
  // On screen, not merely rendered: all three panels stay mounted side by side,
  // so the off-screen ones hold matching text too.
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.right > 0 && r.left < W.innerWidth;
  };
  // An element's own text, ignoring child elements such as icons. Disclosure
  // toggles also prefix their label with a ▼/▲ glyph.
  const label = (e) =>
    [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/[▼▲]/g, '').trim();
  const leaf = (text) => [...d.querySelectorAll('body *')].filter((e) => label(e) === text && visible(e)).pop();
  /** Top-bar tabs render their label uppercased by CSS. */
  const panelTab = (name) =>
    [...d.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim().toUpperCase() === name);
  const button = (label) =>
    [...d.querySelectorAll('button')].find((b) => visible(b) && (b.textContent.trim() === label || b.title === label || b.getAttribute('aria-label') === label));
  /** Climb from a leaf until the ancestor is at least minH tall: the card or panel holding it. */
  const block = (text, minH) => {
    let e = leaf(text);
    while (e && e.getBoundingClientRect().height < minH) e = e.parentElement;
    return e;
  };
  const rect = (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + off.x, y: r.y + off.y, w: r.width, h: r.height };
  };
  const union = (...rs) => {
    const x = Math.min(...rs.map((r) => r.x));
    const y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
  };
  /** The workspace sidebar is outside the project iframe. */
  const topLeaf = (text) => [...document.querySelectorAll('body *')].filter((e) => label(e) === text).pop();
  const sessionRows = () => [...d.querySelectorAll('div[draggable=true]')].filter(visible);
  const fillChat = (value) => {
    const el = [...d.querySelectorAll('textarea')].find((e) => e.placeholder.startsWith('Type a message') && visible(e));
    Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new W.Event('input', { bubbles: true }));
    el.focus();
  };
  const fill = (value) => {
    const el = [...d.querySelectorAll('input')].find((e) => (e.placeholder || '').startsWith('Enter command'));
    Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new W.Event('input', { bubbles: true }));
    el.focus();
  };
`;

class Tab {
  constructor(id) {
    this.id = id;
  }
  run(...args) {
    return cockpit('browser', this.id, ...args);
  }
  /** Runs `body` (a function body using PAGE_HELPERS) and returns its JSON-decoded result. */
  eval(body) {
    const out = this.run('evaluate', `(() => { ${PAGE_HELPERS} return JSON.stringify((() => { ${body} })()); })()`);
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`evaluate returned non-JSON: ${out}`);
    }
  }
  async waitFor(body, what, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (this.eval(body)) return;
      } catch {
        /* the iframe may not exist yet */
      }
      await sleep(300);
    }
    let shot = '';
    try {
      shot = ` (screen at failure: ${this.screenshot()})`;
    } catch {
      /* best effort */
    }
    throw new Error(`timed out waiting for ${what}${shot}`);
  }
  /** Opens a new Claude tab in the current project and sends `prompt`. */
  async startSession(prompt) {
    const before = this.eval(`return sessionRows().length;`);
    this.eval(`button('New session').click(); return true;`);
    await this.waitFor(`return !!leaf('Codex');`, 'engine menu');
    this.eval(`leaf('Claude').closest('button').click(); return true;`);
    await this.waitFor(`return sessionRows().length > ${before};`, 'new session tab');
    await sleep(800);
    this.eval(`fillChat(${JSON.stringify(prompt)}); return true;`);
    this.run('key', 'Enter');
    await this.waitFor(`return !!leaf(${JSON.stringify(prompt)});`, 'sent prompt');
  }
  async switchProject(name) {
    this.eval(`topLeaf(${JSON.stringify(name)}).click(); return true;`);
    await this.waitFor(`return !!leaf(${JSON.stringify(`${ROOT}/${name}`)}) && !!button('New session');`, `project ${name}`);
    await sleep(800);
  }
  async command(line) {
    this.eval(`fill(${JSON.stringify(line)}); return true;`);
    this.run('key', 'Enter');
  }
  screenshot() {
    const out = this.run('screenshot');
    const path = out.split('\n').find((l) => l.trim().endsWith('.png'))?.trim();
    if (!path || !existsSync(path)) throw new Error(`no screenshot path in: ${out}`);
    return path;
  }
}

// ─────────────────────────────────────────────────────────
// The frames. Each step leaves the UI in the state to capture and returns
// { focus, cursor } in viewport pixels.
// ─────────────────────────────────────────────────────────

const FRAMES = [
  {
    id: 'parallel',
    zoom: 1.6,
    async setup(tab, { sessions }) {
      await tab.waitFor(`return !!leaf('New session');`, 'session list');
      let current = 'acme-api';
      for (const session of sessions) {
        if (session.project !== current) {
          await tab.switchProject(session.project);
          current = session.project;
        }
        await tab.startSession(session.prompt);
      }
      if (current !== 'acme-api') await tab.switchProject('acme-api');
      // Long enough for the newest session to be streaming its reply, short
      // enough that the first one has not finished.
      await sleep(7000);
      return tab.eval(`
        const projects = union(rect(topLeaf('acme-api')), rect(topLeaf('web-dashboard')));
        const rows = sessionRows().map(rect);
        const panel = union(...rows);
        return {
          focus: union({ ...projects, x: 0, w: panel.x }, panel),
          cursor: rect(button('New session')),
        };`);
    },
  },
  {
    id: 'harvest',
    zoom: 1.3,
    async setup(tab, { sessions, mock }) {
      const end = Date.now() + 120000;
      while (mock.stats.finished < sessions.length) {
        if (Date.now() > end) throw new Error(`only ${mock.stats.finished}/${sessions.length} sessions finished`);
        await sleep(500);
      }
      // The CLI still asks for a next-prompt suggestion after each turn.
      await tab.waitFor(`return !d.body.textContent.includes('Claude running');`, 'runs to settle', 30000);
      await sleep(2000);
      // Open one of the finished, unread sessions and show the work behind it.
      tab.eval(`
        sessionRows().find((r) => r.textContent.includes('integer cents')).click();
        return true;`);
      await tab.waitFor(`return !!leaf('Three places touch money:') && !!leaf('Expand');`, 'currency session');
      tab.eval(`leaf('Expand').click(); return true;`);
      await tab.waitFor(`return !!leaf('Collapse');`, 'expanded tool calls');
      await sleep(800);
      return tab.eval(`
        const row = sessionRows().find((r) => r.textContent.includes('integer cents'));
        const reply = union(rect(leaf('Three places touch money:')), rect(block('Collapse', 100)));
        return { focus: union(union(...sessionRows().map(rect)), reply), cursor: rect(row) };`);
    },
  },
  {
    id: 'engines',
    zoom: 1.6,
    async setup(tab) {
      tab.eval(`button('New session').click(); return true;`);
      await tab.waitFor(`return !!leaf('Codex') && !!leaf('Ollama');`, 'engine menu');
      await sleep(300);
      return tab.eval(`
        const top = leaf('Claude'), bottom = leaf('Ollama');
        let menu = top;
        while (menu && !menu.contains(bottom)) menu = menu.parentElement;
        return { focus: rect(menu), cursor: rect(button('New session')) };`);
    },
  },
  {
    id: 'diff',
    zoom: 1.35,
    async setup(tab) {
      // Dismiss the engine menu, then Explorer → Status → payments.ts.
      tab.eval(`d.body.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true })); return true;`);
      tab.eval(`panelTab('EXPLORER').click(); return true;`);
      await tab.waitFor(`return !!button('Status');`, 'explorer tabs');
      tab.eval(`button('Status').click(); return true;`);
      await tab.waitFor(`return !!leaf('payments.ts');`, 'status list');
      tab.eval(`leaf('payments.ts').parentElement.click(); return true;`);
      await tab.waitFor(`return !!leaf('Unstaged');`, 'diff view');
      await sleep(800);
      return tab.eval(`
        // The added lines: every visible '+' in the diff's marker column.
        const pane = rect(block('Unstaged', 600));
        const added = union(...[...d.querySelectorAll('body *')].filter((e) => label(e) === '+' && visible(e)).map(rect).filter((r) => r.x > pane.x));
        const code = { y: added.y - 8, h: added.h + 16 };
        return { focus: { x: pane.x, y: code.y, w: pane.w, h: code.h }, cursor: rect(leaf('Unstaged')) };`);
    },
  },
  {
    id: 'console',
    zoom: 1.3,
    async setup(tab) {
      tab.eval(`panelTab('CONSOLE').click(); return true;`);
      await tab.waitFor(`return !!leaf('New PTY');`, 'empty console');
      await tab.command('npm test');
      await tab.waitFor(`return !!leaf('Exit code: 0');`, 'npm test');
      await tab.command('README.md');
      await sleep(2500);
      await tab.command('git log --oneline --stat');
      await sleep(1500);
      await tab.command('git status');
      await tab.waitFor(`return [...d.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === 'Exit code: 0').length >= 3;`, 'git bubbles');
      await sleep(1500);
      return tab.eval(`
        const test = block('npm test', 400);
        const exit = [...test.querySelectorAll('*')].find((e) => label(e) === 'Exit code: 0');
        return { focus: rect(test), cursor: rect(exit) };`);
    },
  },
];

// ─────────────────────────────────────────────────────────

async function waitForServer() {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`demo server did not come up on :${PORT}`);
}

const pct = (v, total) => Math.round((v / total) * 10000) / 100;
const toPct = (r) => ({ x: pct(r.x, VIEWPORT.width), y: pct(r.y, VIEWPORT.height), w: pct(r.w, VIEWPORT.width), h: pct(r.h, VIEWPORT.height) });

async function main() {
  if (!existsSync(join(REPO, '.next-prod'))) {
    throw new Error('no production build at the repo root — run `npm run build && npm run build:server` there first');
  }

  const { home, api } = seed(ROOT);
  console.log(`seeded ${ROOT}`);

  const sessions = parallelSessions(ROOT);
  const mock = await startMockAnthropic({ port: MOCK_PORT, replies: sessions });
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: REPO,
    env: {
      ...process.env,
      HOME: home,
      PORT: String(PORT),
      COCKPIT_NO_OPEN: '1',
      // Claude CLI → the stand-in. Never a real key or the real endpoint.
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      ANTHROPIC_API_KEY: 'sk-ant-tour-demo',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdio: 'ignore',
  });
  let tab;
  try {
    await waitForServer();
    console.log(`demo server on :${PORT}`);

    const url = `http://localhost:${PORT}/?cwd=${encodeURIComponent(api)}`;
    const opened = cockpit('browser', 'open', url);
    const id = opened.split(/\s+/)[0];
    tab = new Tab(id);
    tab.run('viewport', `${VIEWPORT.width}x${VIEWPORT.height}`, '--dpr', '2');
    tab.run('show');
    await sleep(1500);

    mkdirSync(OUT_DIR, { recursive: true });
    const frames = [];
    for (const frame of FRAMES) {
      const { focus, cursor } = await frame.setup(tab, { sessions, mock });
      const png = tab.screenshot();
      const file = join(OUT_DIR, `${frame.id}.webp`);
      await sharp(png).resize({ width: OUT_WIDTH }).webp({ quality: 80 }).toFile(file);
      rmSync(png, { force: true });
      frames.push({
        id: frame.id,
        src: `/tour/${frame.id}.webp`,
        zoom: frame.zoom,
        focus: toPct(focus),
        // The point the cursor travels to: centre of the element it "clicks".
        cursor: { x: pct(cursor.x + cursor.w / 2, VIEWPORT.width), y: pct(cursor.y + cursor.h / 2, VIEWPORT.height) },
      });
      console.log(`captured ${frame.id}`);
    }

    const { width, height } = await sharp(join(OUT_DIR, `${FRAMES[0].id}.webp`)).metadata();
    writeFileSync(DATA_FILE, JSON.stringify({ width, height, frames }, null, 2) + '\n');
    console.log(`wrote ${DATA_FILE}`);
  } finally {
    if (tab) {
      try {
        tab.run('viewport', 'reset');
        tab.run('close');
      } catch {
        /* tab already gone */
      }
    }
    server.kill('SIGTERM');
    mock.closeAllConnections();
    mock.close();
    await sleep(1000);
    rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
