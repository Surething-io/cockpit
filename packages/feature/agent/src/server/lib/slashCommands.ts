// One file per command — body lives in `<cmd>Prompt.ts`, this file stays a
// thin index. Adding a new builtin: create `<cmd>Prompt.ts` exporting
// `<CMD>_PROMPT_ZH` and `<CMD>_PROMPT_EN`, then wire it here AND register a
// matching entry in `packages/feature/agent/src/server/api/commands.ts` so the
// autocomplete dropdown also lists it.
//
// `labelZh` / `labelEn` are OPTIONAL per command. Set them only when the
// command wants to override the default neutral "问题：" / "Question: "
// prefix attached to the user's trailing text — see `/cg` which uses
// "探索问题：" / "Exploration: " to prime a stronger model mindset.
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { COCKPIT_DIR, SKILLS_FILE } from '@cockpit/shared-utils';
import { AP_PROMPT_EN, AP_PROMPT_ZH } from './apPrompt';
import { CC_LABEL_EN, CC_LABEL_ZH, CC_PROMPT_EN, CC_PROMPT_ZH } from './ccPrompt';
import { CG_LABEL_EN, CG_LABEL_ZH, CG_PROMPT_EN, CG_PROMPT_ZH } from './cgPrompt';
import { CR_PROMPT_EN, CR_PROMPT_ZH } from './crPrompt';
import { EX_PROMPT_EN, EX_PROMPT_ZH } from './exPrompt';
import { FX_PROMPT_EN, FX_PROMPT_ZH } from './fxPrompt';
import { GO_PROMPT_EN, GO_PROMPT_ZH } from './goPrompt';
import {
  NEW_BRANCH_LABEL_EN,
  NEW_BRANCH_LABEL_ZH,
  NEW_BRANCH_PROMPT_EN,
  NEW_BRANCH_PROMPT_ZH,
} from './newBranchPrompt';
import { QA_PROMPT_EN, QA_PROMPT_ZH } from './qaPrompt';
import {
  SKILLIFY_LABEL_EN,
  SKILLIFY_LABEL_ZH,
  SKILLIFY_PROMPT_EN,
  SKILLIFY_PROMPT_ZH,
} from './skillifyPrompt';

interface CommandEntry {
  /** Prompt content for each language — a COMPLETE SKILL.md (YAML frontmatter +
   *  body), same shape as a user-defined skill. Written to disk verbatim. */
  zh: string;
  en: string;
  /** Optional override for the "問題：" / "Question: " prefix prepended to the
   *  user's trailing text. When omitted, dispatch falls back to the default. */
  labelZh?: string;
  labelEn?: string;
}

export const COMMAND_CONTENT: Record<string, CommandEntry> = {
  qa: { zh: QA_PROMPT_ZH, en: QA_PROMPT_EN },
  ap: { zh: AP_PROMPT_ZH, en: AP_PROMPT_EN },
  fx: { zh: FX_PROMPT_ZH, en: FX_PROMPT_EN },
  ex: { zh: EX_PROMPT_ZH, en: EX_PROMPT_EN },
  go: { zh: GO_PROMPT_ZH, en: GO_PROMPT_EN },
  cg: { zh: CG_PROMPT_ZH, en: CG_PROMPT_EN, labelZh: CG_LABEL_ZH, labelEn: CG_LABEL_EN },
  cc: { zh: CC_PROMPT_ZH, en: CC_PROMPT_EN, labelZh: CC_LABEL_ZH, labelEn: CC_LABEL_EN },
  cr: { zh: CR_PROMPT_ZH, en: CR_PROMPT_EN },
  'new-branch': {
    zh: NEW_BRANCH_PROMPT_ZH,
    en: NEW_BRANCH_PROMPT_EN,
    labelZh: NEW_BRANCH_LABEL_ZH,
    labelEn: NEW_BRANCH_LABEL_EN,
  },
  skillify: {
    zh: SKILLIFY_PROMPT_ZH,
    en: SKILLIFY_PROMPT_EN,
    labelZh: SKILLIFY_LABEL_ZH,
    labelEn: SKILLIFY_LABEL_EN,
  },
};

/** Directory holding the on-disk copies of builtin slash commands, written as
 *  SKILL.md files so the model reads them through the SAME flow as user-defined
 *  skills (`请读取这个 skill 文件：<path>`) instead of inlining the full template. */
const BUILTIN_SKILLS_DIR = join(COCKPIT_DIR, 'skills');

/**
 * Derive the base URL the AI should use in its curl recipes.
 *
 * Always `http://localhost:<COCKPIT_PORT>`. The only consumer of {{BASE_URL}}
 * is /cg's curl recipes, which the agent runs via bash on the *same machine*
 * as the server — so loopback is always reachable, never needs auth, and never
 * leaks a token into the user-visible / on-disk SKILL.md. We deliberately do
 * NOT honor X-Forwarded-Host: a public/proxy URL would force the curls through
 * the auth gate (401) and is irrelevant to a co-located executor.
 */
function deriveBaseUrl(): string {
  const port = process.env.COCKPIT_PORT || process.env.PORT || '3457';
  return `http://localhost:${port}`;
}

// A single parsed command step: its marker, verb, and the body text that
// belongs to it (everything up to the next command line).
type StepMarker = '/' | '@';
interface ParsedStep {
  marker: StepMarker;
  cmd: string;
  body: string;
}

// One command line: `/verb …` or `@verb …` at the start of a line (leading
// whitespace allowed). Verb starts with a letter, then letters/digits/hyphens
// (/qa, /new-branch, /c4). Char class is kept in sync with the client
// autocomplete (ChatInput's commandQuery).
const COMMAND_LINE_RE = /^\s*([/@])([a-zA-Z][a-zA-Z0-9-]*)(?:\s+|$)/;

// Resolves slash/at commands before the prompt is sent to the model. Supports:
//   - multiple commands, one per line — each line starting with `/verb` or
//     `@verb` begins a step; its body runs until the next command line
//     (multi-line + blank lines included).
//   - `/verb` runs in the main session; `@verb` is delegated to a subagent.
//   - builtin commands (COMMAND_CONTENT) AND user-registered skills, mixed.
//
// Each command resolves to a "read this SKILL.md" pointer (builtins are written
// to ~/.cockpit/skills/<verb>/SKILL.md; user skills use their registered path) —
// the SAME flow user-defined skills use, keeping the first message compact.
//
// A single `/verb` command (no preamble, no `@`) keeps the original compact
// "pointer + label + body" output. Two+ commands, or any `@`, or leading
// preamble text, switch to a numbered step list framed for sequential dispatch.
//
// `{{BASE_URL}}` placeholders are substituted at WRITE time with the loopback
// base URL (http://localhost:<port>) — /cg's curl recipes are executed by the
// agent on the server host, so loopback is always reachable and never needs a
// token. `_req` is kept on the signature for call-site threading but is no
// longer consulted for the base URL (see deriveBaseUrl).
export function resolveCommandPrompt(
  prompt: string,
  language = 'en',
  _req?: Request,
): string {
  const lang: 'zh' | 'en' = language.startsWith('zh') ? 'zh' : 'en';

  // Skill registry read once per dispatch (not per keystroke) so command-line
  // recognition can tell a real `/skill-name` from ordinary text-with-slash.
  const userSkills = listUserSkills();
  const isKnown = (cmd: string) =>
    !!COMMAND_CONTENT[cmd] || userSkills.some((s) => s.name === cmd);

  // ── Parse: find known command lines, split bodies between them ──
  const lines = prompt.split('\n');
  const marks: Array<{ i: number; marker: StepMarker; cmd: string; rest: string }> = [];
  lines.forEach((line, i) => {
    const m = line.match(COMMAND_LINE_RE);
    if (m && isKnown(m[2])) {
      marks.push({ i, marker: m[1] as StepMarker, cmd: m[2], rest: line.slice(m[0].length) });
    }
  });
  if (marks.length === 0) return prompt;

  const preamble = lines.slice(0, marks[0].i).join('\n').trim();
  const steps: ParsedStep[] = marks.map((mk, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].i : lines.length;
    const body = [mk.rest, ...lines.slice(mk.i + 1, end)].join('\n').trim();
    return { marker: mk.marker, cmd: mk.cmd, body };
  });

  const baseUrl = deriveBaseUrl();
  const resolved = steps.map((s) => resolveStep(s, lang, baseUrl, userSkills));

  // ── Single `/command`, no preamble → original compact output ──
  if (resolved.length === 1 && resolved[0].marker === '/' && !preamble) {
    const r = resolved[0];
    return r.body ? `${r.pointer}\n\n${r.label}${r.body}` : r.pointer;
  }

  // ── Otherwise: numbered, locus-annotated step list ──
  const intro = lang === 'zh' ? '请按以下步骤依次完成：' : 'Complete the following steps in order:';
  const blocks = resolved.map((r, idx) => {
    const where = stepHeader(idx + 1, r.marker, lang);
    const bodyPart = r.body ? `\n${r.label}${r.body}` : '';
    return `${where}\n${r.pointer}${bodyPart}`;
  });
  const parts: string[] = [];
  if (preamble) parts.push(preamble);
  parts.push(intro, blocks.join('\n\n'));
  return parts.join('\n\n');
}

interface ResolvedStep {
  marker: StepMarker;
  body: string;
  label: string;
  /** The pointer text injected for this step (read-the-SKILL.md, or, if the
   *  builtin write failed, the inlined content as a fallback). */
  pointer: string;
}

// Resolve one parsed step to its pointer text + label. (Callers only pass known
// verbs.) A user skill takes PRECEDENCE over a builtin of the same name —
// restoring the pre-server-resolution behavior where the client expanded the
// user's own skill first. So a user skill named `cr`/`new-branch` shadows the
// builtin; the user's edits to their own skill keep taking effect.
function resolveStep(
  step: ParsedStep,
  lang: 'zh' | 'en',
  baseUrl: string,
  userSkills: Array<{ name: string; path: string }>,
): ResolvedStep {
  const skill = userSkills.find((s) => s.name === step.cmd);
  if (skill) {
    // User-skill invocations carry no mindset-primer label — matches the old
    // client expansion, which appended the trailing text with no prefix.
    return { marker: step.marker, body: step.body, label: '', pointer: readSkillPointer(skill.path, lang) };
  }
  const entry = COMMAND_CONTENT[step.cmd]!;
  const content = entry[lang].replaceAll('{{BASE_URL}}', baseUrl);
  const skillPath = writeBuiltinSkill(step.cmd, content);
  // On write failure, inline the content so the command never silently no-ops.
  const pointer = skillPath ? readSkillPointer(skillPath, lang) : content;
  return { marker: step.marker, body: step.body, label: labelFor(entry, lang), pointer };
}

/** "Please read this skill file: <path>" pointer in the active language. */
function readSkillPointer(skillPath: string, lang: 'zh' | 'en'): string {
  return lang === 'zh'
    ? `请读取这个 skill 文件：\n${skillPath}`
    : `Please read this skill file:\n${skillPath}`;
}

/** Step header with execution-locus annotation (main session vs subagent). */
function stepHeader(n: number, marker: StepMarker, lang: 'zh' | 'en'): string {
  if (lang === 'zh') {
    return marker === '@'
      ? `步骤 ${n}（用 subagent 执行）：`
      : `步骤 ${n}（主会话执行）：`;
  }
  return marker === '@'
    ? `Step ${n} (run in a subagent): `
    : `Step ${n} (run in the main session): `;
}

interface SkillRecord {
  id: string;
  path: string;
  addedAt: string;
}

// Read the user-skill registry (~/.cockpit/skills.json) and resolve each
// record's `name` from its SKILL.md frontmatter. Synchronous — runs once per
// dispatch, reads a handful of small local files; keeps resolveCommandPrompt
// sync for the five engine handlers that call it inside Effect.gen.
function listUserSkills(): Array<{ name: string; path: string }> {
  try {
    const data = JSON.parse(readFileSync(SKILLS_FILE, 'utf-8')) as {
      skills?: SkillRecord[];
    };
    const out: Array<{ name: string; path: string }> = [];
    for (const s of data.skills ?? []) {
      const name = readSkillName(s.path);
      if (name) out.push({ name, path: s.path });
    }
    return out;
  } catch {
    return [];
  }
}

// Extract the `name:` field from a SKILL.md YAML frontmatter block. Minimal
// sync parse (no async parseSkillMd dependency) — just enough to match a
// `/name` command to its file.
function readSkillName(path: string): string | null {
  try {
    const txt = readFileSync(path, 'utf-8');
    const fm = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const block = fm ? fm[1] : txt;
    const m = block.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// Write a builtin command's resolved SKILL.md to ~/.cockpit/skills/<cmd>/SKILL.md
// and return the absolute path. `content` IS a complete SKILL.md (YAML
// frontmatter + body) — identical in shape to a user-defined skill — so it's
// written verbatim, no frontmatter synthesis. Overwritten on every dispatch so
// the file always reflects the current code + the loopback base URL.
// Returns null on any failure so the caller can fall back to inlining.
//
// Synchronous fs on purpose: keeps resolveCommandPrompt's sync signature — all
// five engine chat handlers (chat.ts + chat/{codex,deepseek,kimi,ollama}.ts)
// invoke it inline inside an Effect.gen — and the payload is a single small
// local file, same pattern as notifyReviewChange.
function writeBuiltinSkill(cmd: string, content: string): string | null {
  try {
    const dir = join(BUILTIN_SKILLS_DIR, cmd);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'SKILL.md');
    writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
    return filePath;
  } catch {
    return null;
  }
}

/** Pick the "label:" prefix for a command's trailing user text. Uses the
 *  entry's per-command override when set, otherwise falls back to a neutral
 *  question label. */
function labelFor(entry: CommandEntry, lang: 'zh' | 'en'): string {
  const custom = lang === 'zh' ? entry.labelZh : entry.labelEn;
  if (custom) return custom;
  return lang === 'zh' ? '问题：' : 'Question: ';
}
