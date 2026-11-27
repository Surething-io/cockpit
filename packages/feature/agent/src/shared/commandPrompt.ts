/**
 * The shape resolveCommandPrompt gives a message, written and read in one place.
 *
 * A message with `/skill`, `/@skill`, `@bot` or `@<session Bot>` lines is stored the way the
 * MODEL needs it: each command line rewritten to a `[locus·name] body` tag, and a footer of
 * blocks after it — skill files to read, paths to hand on, the sessions addressed, and lines
 * that were not recognised. That text stays in the transcript verbatim.
 *
 * People should see what they typed instead. parseCommandPrompt turns the stored text back
 * into the typed form (`[subagent·cr] x` → `/@cr x`, `[session·@Payments] x` → `@Payments x`)
 * plus the footer's references, so the chat bubble can fold them and titles / previews can
 * drop them. The headers below are what slashCommands writes; keeping them here is what keeps
 * writer and reader from drifting.
 */

import { parseMessageOrigin } from './messageOrigin';

type Lang = 'zh' | 'en';

export const FOOTER_HEADERS = {
  read: {
    zh: '请先读取以下 skill 文件，再据此执行：',
    en: 'Read these skill files first, then act accordingly:',
  },
  /** Handoff list when every Bot line is delegated. */
  handoff: {
    zh: '以下文件交给你派发的子会话去读，你只转交路径，不要自己打开：',
    en: 'These files are for the session you delegate to. Pass the paths along; do not open them yourself:',
  },
  /** Handoff list when a Bot also runs here (bot-turn is then in both lists). */
  handoffMixed: {
    zh: '以下路径原样转交给你派发的子会话；除上面读取列表已列出的以外，不要自己打开：',
    en: 'Pass these paths verbatim to the session you delegate to; do not open any that the read list above does not already list:',
  },
  targets: {
    zh: '以上 [session·@…] 行指向的会话（cwd 与 sessionId 原样使用）：',
    en: 'Sessions the [session·@…] lines above address (use cwd and sessionId verbatim):',
  },
  unresolved: {
    zh: '以下 @ 开头的行没有被识别，已按普通文本处理，请告知用户：',
    en: 'These @ lines were not recognised and were left as plain text. Tell the user:',
  },
} as const satisfies Record<string, Record<Lang, string>>;

export type FooterKind = keyof typeof FOOTER_HEADERS;

export const footerHeader = (kind: FooterKind, lang: Lang): string => FOOTER_HEADERS[kind][lang];

/** One line of the user's own text; `command` is set when the line was a command. */
export interface PromptLine {
  /** As typed: `/cr`, `/@cr`, `@bot`, `@Payments fix`. */
  command: string | null;
  text: string;
}

export interface CommandReference {
  kind: Exclude<FooterKind, 'unresolved'> | 'inline';
  /** `cr`, `@bot`, `bot-turn`, `@Payments` — or the inline skill's name. */
  name: string;
  /** A path, a `{cwd, sessionId}` JSON, or empty for inline content. */
  detail: string;
}

export interface ParsedCommandPrompt {
  lines: PromptLine[];
  /** The footer's references (files to read, paths handed on, sessions addressed). */
  references: CommandReference[];
  /** "Not recognised" notes — meant for the user, so shown rather than folded. */
  notes: string[];
}

const HEADER_KIND = new Map<string, FooterKind>(
  (Object.entries(FOOTER_HEADERS) as Array<[FooterKind, Record<Lang, string>]>)
    .flatMap(([kind, byLang]) => [[byLang.zh, kind], [byLang.en, kind]] as Array<[string, FooterKind]>),
);

/** A builtin inlined in full (its file could not be written) — a SKILL.md, frontmatter first. */
const INLINE_SKILL = /^---\nname:\s*([^\n]+)/;

/**
 * `[name]`, `[main·name]`, `[subagent·@bot]`, `[session·@Some title] body`. The name ends at
 * the first `]` followed by a space or the end of the line, so `[session·@API [v2]] go` reads
 * as `@API [v2]`; session tags are matched against the listed targets first (parseLine).
 */
const TAG_LINE = /^\[(?:(main|subagent|session)·)?(.+?)\](?: (.*))?$/;

/** A footer block: a known header line followed only by `- ` item lines (at least one). */
const isHeaderBlock = (block: string): boolean => {
  const [first, ...rest] = block.split('\n');
  return HEADER_KIND.has(first) && rest.length > 0 && rest.every((line) => line.startsWith('- '));
};

/**
 * Where the footer starts, found from the END: resolveCommandPrompt always appends it last,
 * as a run of header blocks (an inlined SKILL.md only ever right after one of them). Walking
 * back over exactly that run means a header the user QUOTED in their own text — followed by
 * more of their text — is never mistaken for it, nor is a SKILL.md they pasted.
 * Returns the character offset, or -1 when the text does not end in a footer.
 */
function footerStart(text: string): number {
  const blocks = text.split('\n\n');
  let i = blocks.length - 1;
  let found = false;
  while (i >= 0) {
    if (isHeaderBlock(blocks[i])) { found = true; i--; continue; }
    // An inlined SKILL.md (it has blank lines of its own, and may be the very last thing):
    // its first block starts with the frontmatter and directly follows a header block of
    // this same footer — that adjacency is the proof it is ours, not a paste.
    let j = i;
    while (j > 0 && !INLINE_SKILL.test(blocks[j])) j--;
    if (j > 0 && INLINE_SKILL.test(blocks[j]) && isHeaderBlock(blocks[j - 1])) { found = true; i = j - 1; continue; }
    break;
  }
  if (!found) return -1;
  // Offset of block i + 1: every earlier block plus its "\n\n" separator.
  let offset = 0;
  for (let k = 0; k <= i; k++) offset += blocks[k].length + 2;
  return i < 0 ? 0 : offset - 2;
}

const listItem = (line: string, kind: FooterKind): { name: string; detail: string } | null => {
  // A target's name is a session title and may itself contain ": " — its detail is the
  // JSON object at the end of the line, so split there.
  const m = kind === 'targets' ? line.match(/^- (.+)(?:：|: )(\{.*\})$/) : line.match(/^- (.+?)(?:：|: )(.*)$/);
  return m ? { name: m[1], detail: m[2] } : null;
};

/** How a tag reads as typed. A lone `[name]` and `main·name` were `/name`. */
function typedCommand(locus: string | undefined, name: string): string {
  if (name.startsWith('@')) return name;
  return locus === 'subagent' ? `/@${name}` : `/${name}`;
}

/**
 * The typed form of a stored message, or null when it carries nothing resolveCommandPrompt
 * wrote — ordinary messages are left alone. It must PROVE it is one: a footer that starts
 * with a known header, and (unless the footer is only "not recognised" notes) at least one
 * command tag line in the body. A user's own `[1] foo`, or a pasted SKILL.md, is never
 * mistaken for a command message.
 */
export function parseCommandPrompt(text: string): ParsedCommandPrompt | null {
  const start = footerStart(text);
  if (start === -1) return null;
  const body = text.slice(0, start);
  const footer = text.slice(start).replace(/^\n+/, '');

  const references: CommandReference[] = [];
  const notes: string[] = [];
  let kind: FooterKind | 'inline' | null = null;
  for (const block of footer.split(/\n\n(?=\S)/)) {
    const [first, ...rest] = block.split('\n');
    const headerKind = HEADER_KIND.get(first);
    const inline = kind !== null ? block.match(INLINE_SKILL) : null;
    if (headerKind) kind = headerKind;
    else if (inline) {
      references.push({ kind: 'inline', name: inline[1].trim().replace(/^["']|["']$/g, ''), detail: '' });
      kind = 'inline';
      continue;
    } else if (kind === 'inline') continue; // the rest of an inlined SKILL.md
    for (const line of headerKind ? rest : [first, ...rest]) {
      if (kind === 'unresolved') {
        if (line.startsWith('- ')) notes.push(line.slice(2));
        continue;
      }
      const item = kind ? listItem(line, kind) : null;
      if (item && kind) references.push({ kind, ...item });
    }
  }

  const listed = new Set(references.map((r) => r.name));
  // Longest first, so `@Login fix` wins over `@Login` on `[session·@Login fix] …`.
  const targets = references.filter((r) => r.kind === 'targets').map((r) => r.name).sort((a, b) => b.length - a.length);
  const parseLine = (line: string): PromptLine => {
    if (line.startsWith('[session·')) {
      for (const name of targets) {
        const tag = `[session·${name}]`;
        if (line.startsWith(tag) && (line.length === tag.length || line[tag.length] === ' ')) {
          return { command: name, text: line.slice(tag.length + 1) };
        }
      }
    }
    const m = line.match(TAG_LINE);
    if (!m) return { command: null, text: line };
    const [, locus, name, rest = ''] = m;
    // A bare `[name]` is a command only when the footer lists it.
    if (!locus && !listed.has(name)) return { command: null, text: line };
    return { command: typedCommand(locus, name), text: rest };
  };
  const lines = (body ? body.split('\n') : []).map(parseLine);
  // Anything but a notes-only footer needs a command line to have produced it.
  const notesOnly = references.length === 0 && notes.length > 0;
  if (!notesOnly && !lines.some((l) => l.command)) return null;
  // Trailing blank lines are the separator before the footer.
  while (lines.length && lines[lines.length - 1].command === null && !lines[lines.length - 1].text.trim()) lines.pop();
  return { lines, references, notes };
}

/** The typed form as plain text — for titles, previews and anything else a person reads. */
export function typedPromptText(text: string): string {
  const parsed = parseCommandPrompt(text);
  if (!parsed) return text;
  return parsed.lines.map((l) => (l.command ? (l.text ? `${l.command} ${l.text}` : l.command) : l.text)).join('\n');
}

/**
 * What a person reads a stored user turn as: no origin line from another session, no
 * resolved-command footer, commands as typed. For titles, previews and search snippets.
 */
export function humanUserText(text: string): string {
  const origin = parseMessageOrigin(text);
  return typedPromptText(origin ? origin.body : text);
}
