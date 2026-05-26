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
import { CC_LABEL_EN, CC_LABEL_ZH, CC_PROMPT_EN, CC_PROMPT_ZH } from './ccPrompt';
import { CG_LABEL_EN, CG_LABEL_ZH, CG_PROMPT_EN, CG_PROMPT_ZH } from './cgPrompt';
import { EX_PROMPT_EN, EX_PROMPT_ZH } from './exPrompt';
import { FX_PROMPT_EN, FX_PROMPT_ZH } from './fxPrompt';
import { GO_PROMPT_EN, GO_PROMPT_ZH } from './goPrompt';
import { QA_PROMPT_EN, QA_PROMPT_ZH } from './qaPrompt';

interface CommandEntry {
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
};

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

// Expands /qa, /fx, /cg etc. into their full instruction text before the
// prompt is sent to the model. Reads COMMAND_CONTENT keyed by the verb after
// the slash and the user's language (zh / en).
//
// `{{BASE_URL}}` placeholders inside the content are substituted with the
// live base URL derived from the incoming request (or fallback to
// http://localhost:<port>). This makes /cg's curl recipes reachable from
// whatever URL the user actually sees cockpit at — localhost for local dev,
// the deployment's public URL when behind a reverse proxy.
export function resolveCommandPrompt(
  prompt: string,
  language = 'en',
  req?: Request,
): string {
  const trimmed = prompt.trimStart();
  const match = trimmed.match(/^\/([a-zA-Z]+)(?:\s+|$)/);
  if (!match) return prompt;

  const cmd = match[1];
  const lang = language.startsWith('zh') ? 'zh' : 'en';
  const entry = COMMAND_CONTENT[cmd];
  const tmpl = entry?.[lang];
  if (!tmpl) return prompt;

  const baseUrl = deriveBaseUrl(req);
  const content = tmpl.replaceAll('{{BASE_URL}}', baseUrl);

  const rest = trimmed.slice(match[0].length).trimStart();
  // The label prepended to the user's trailing text isn't just a separator —
  // it's a mindset primer for the model. `/cg` switches the user into project
  // graph EXPLORATION; tagging the input "探索问题" / "Exploration:" up-front
  // anchors the model on graph-tool usage instead of defaulting to grep/glob.
  // Other commands keep the neutral "问题：" / "Question:" label.
  const label = labelFor(entry, lang);
  return rest ? `${content}\n\n${label}${rest}` : content;
}

/** Pick the "label:" prefix for a command's trailing user text. Uses the
 *  entry's per-command override when set, otherwise falls back to a neutral
 *  question label. */
function labelFor(entry: CommandEntry, lang: 'zh' | 'en'): string {
  const custom = lang === 'zh' ? entry.labelZh : entry.labelEn;
  if (custom) return custom;
  return lang === 'zh' ? '问题：' : 'Question: ';
}
