'use client';

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { addSkill, notifySkillsChanged } from '@cockpit/shared-api';
import { BrowserRuntime } from '@cockpit/effect-runtime';

/**
 * Shared "add this SKILL.md to the skills registry (skills.json)" action, used by
 * the explorer file-tree toolbar + the markdown-preview header button. Toasts
 * "added" / "already added" / error, and notifies the registry bus so SkillsModal
 * and the chat `/` autocomplete refresh.
 *
 * `path` must be absolute (POST /api/skills rejects relative paths). Mirrors
 * useAddHtmlApp; the registry IO + bus live in @cockpit/shared-api because homing
 * them in feature-skills would make this import a package cycle.
 *
 * No client-side validation on purpose — same as the HTML button and the manual
 * "Add Skill" dialog. The server's only check is that the file is readable
 * (parseSkillMd falls back to the parent directory name when frontmatter is
 * absent), so gating here would reject files the manual path accepts.
 */
export function useAddSkill(): (path: string) => Promise<void> {
  const { t } = useTranslation();
  return useCallback(async (path: string) => {
    const exit = await BrowserRuntime.runPromiseExit(addSkill(path));
    if (exit._tag === 'Success') {
      if (exit.value.alreadyExists) {
        toast(t('skills.alreadyAdded'), 'info');
      } else {
        toast(t('skills.added'), 'success');
        notifySkillsChanged();
      }
    } else {
      const failure = exit.cause._tag === 'Fail' ? exit.cause.error : null;
      const inner = failure?.cause;
      const msg = inner instanceof Error ? inner.message : t('skills.addFailed');
      toast(msg, 'error');
    }
  }, [t]);
}
