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
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { COCKPIT_DIR } from '@cockpit/shared-utils';
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
};

/** Directory holding the on-disk copies of builtin slash commands, written as
 *  SKILL.md files so the model reads them through the SAME flow as user-defined
 *  skills (`请读取这个 skill 文件：<path>`) instead of inlining the full template. */
const BUILTIN_SKILLS_DIR = join(COCKPIT_DIR, 'skills');

/**
 * Derive the base URL the AI should use in its curl recipes.
 *
 * Why we can't hard-code `http://localhost:<port>`: cockpit may be deployed
 * behind a reverse proxy (nginx / Cloudflare / Tailscale Funnel / etc) at a
 * public URL like `https://cockpit.example.com`. The AI runs bash on the
 * server, so localhost would actually work for the curl execution itself —
 * but the curl command is ALSO shown to the user as part of the AI's
 * reasoning. If the user is on a different machine, "curl localhost:3457"
 * is unreproducible noise.
 *
 * Precedence:
 *   1. X-Forwarded-Proto / X-Forwarded-Host  (reverse proxy: trust them)
 *   2. req.url's origin                       (direct connection: use it)
 *
 * The fallback (no req at all) is `http://localhost:<COCKPIT_PORT>`, used by
 * call sites that don't have a Request handy (rare; tests / CLI).
 */
function deriveBaseUrl(req?: Request): string {
  if (req) {
    const url = new URL(req.url);
    const proto = req.headers.get('x-forwarded-proto');
    const host = req.headers.get('x-forwarded-host');
    if (proto || host) {
      return `${proto ?? url.protocol.replace(':', '')}://${host ?? url.host}`;
    }
    return url.origin;
  }
  const port = process.env.COCKPIT_PORT || process.env.PORT || '3457';
  return `http://localhost:${port}`;
}

// Resolves /qa, /fx, /cg etc. before the prompt is sent to the model. Reads
// COMMAND_CONTENT keyed by the verb after the slash and the user's language
// (zh / en).
//
// Rather than inlining the (long) instruction template into the message, we
// write it to ~/.cockpit/skills/<cmd>/SKILL.md and return a short pointer
// ("请读取这个 skill 文件：<path>") — the SAME flow user-defined skills use.
// The model reads the file on demand, keeping the first message compact.
//
// `{{BASE_URL}}` placeholders inside the content are substituted with the
// live base URL derived from the incoming request (or fallback to
// http://localhost:<port>) at WRITE time. This makes /cg's curl recipes
// reachable from whatever URL the user actually sees cockpit at — localhost
// for local dev, the deployment's public URL when behind a reverse proxy.
export function resolveCommandPrompt(
  prompt: string,
  language = 'en',
  req?: Request,
): string {
  const trimmed = prompt.trimStart();
  // Verb is letters, optionally with hyphens (e.g. /qa, /new-branch). Must start
  // with a letter so a bare "/-x" doesn't match; the captured verb doubles as the
  // COMMAND_CONTENT key and the ~/.cockpit/skills/<verb>/ dir name.
  const match = trimmed.match(/^\/([a-zA-Z][a-zA-Z-]*)(?:\s+|$)/);
  if (!match) return prompt;

  const cmd = match[1];
  const lang = language.startsWith('zh') ? 'zh' : 'en';
  const entry = COMMAND_CONTENT[cmd];
  const tmpl = entry?.[lang];
  if (!tmpl) return prompt;

  const baseUrl = deriveBaseUrl(req);
  const content = tmpl.replaceAll('{{BASE_URL}}', baseUrl);

  // Persist the resolved template as a SKILL.md and get its path back. If the
  // write fails (rare; perms / disk), fall back to inlining the content so the
  // command never silently no-ops.
  const skillPath = writeBuiltinSkill(cmd, content);

  const rest = trimmed.slice(match[0].length).trimStart();
  // The label prepended to the user's trailing text isn't just a separator —
  // it's a mindset primer for the model. `/cg` switches the user into project
  // graph EXPLORATION; tagging the input "探索问题" / "Exploration:" up-front
  // anchors the model on graph-tool usage instead of defaulting to grep/glob.
  // Other commands keep the neutral "问题：" / "Question:" label.
  const label = labelFor(entry, lang);

  if (!skillPath) {
    return rest ? `${content}\n\n${label}${rest}` : content;
  }

  const pointer =
    lang === 'zh'
      ? `请读取这个 skill 文件：\n${skillPath}`
      : `Please read this skill file:\n${skillPath}`;
  return rest ? `${pointer}\n\n${label}${rest}` : pointer;
}

// Write a builtin command's resolved SKILL.md to ~/.cockpit/skills/<cmd>/SKILL.md
// and return the absolute path. `content` IS a complete SKILL.md (YAML
// frontmatter + body) — identical in shape to a user-defined skill — so it's
// written verbatim, no frontmatter synthesis. Overwritten on every dispatch so
// the file always reflects the current code + the current request's base URL.
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
