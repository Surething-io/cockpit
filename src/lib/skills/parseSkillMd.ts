import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname } from 'path';

export interface ParsedSkill {
  name: string;
  description: string;
  icon?: string;
  /** Hint for arguments shown after the command name, e.g. "[topic]" or "<file>" */
  argumentHint?: string;
  /** Raw file content (without frontmatter stripped) */
  content: string;
  valid: boolean;
}

/**
 * Parse YAML-ish frontmatter of a SKILL.md file.
 * Only supports simple `key: value` pairs — sufficient for name / description / icon.
 *
 * Fallbacks:
 *  - name        -> directory name of the file (e.g. "longmemeval-report")
 *  - description -> ""
 *  - icon        -> undefined (caller renders a default icon)
 */
export async function parseSkillMd(absPath: string): Promise<ParsedSkill> {
  if (!absPath || !existsSync(absPath)) {
    return makeInvalid(absPath);
  }

  let content: string;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch {
    return makeInvalid(absPath);
  }

  const fm = extractFrontmatter(content);
  const fallbackName = basename(dirname(absPath)) || basename(absPath);

  return {
    name: sanitizeName(fm.name) || fallbackName,
    description: fm.description || '',
    icon: fm.icon || undefined,
    argumentHint: fm['argument-hint'] || fm.argumenthint || fm.hint || undefined,
    content,
    valid: true,
  };
}

function makeInvalid(absPath: string): ParsedSkill {
  const fallbackName = absPath
    ? (basename(dirname(absPath)) || basename(absPath))
    : 'unknown';
  return {
    name: fallbackName,
    description: '',
    icon: undefined,
    argumentHint: undefined,
    content: '',
    valid: false,
  };
}

function extractFrontmatter(raw: string): Record<string, string> {
  // Expected form:
  // ---
  // key: value
  // ...
  // ---
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
  if (!match) return {};

  const body = match[1];
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    let value = m[2].trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * A skill name is used as a slash command trigger. Only allow
 * characters safe to type as `/<name>` — letters, digits, -, _, :, .
 * Spaces etc. are replaced with '-'.
 */
function sanitizeName(name: string | undefined): string {
  if (!name) return '';
  return name.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9\-_:.]/g, '');
}
