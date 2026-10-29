'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { loadSkillContent } from '@cockpit/shared-api';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { DirectoryPane } from './DirectoryPane';

interface SkillPreviewPaneProps {
  skillId: string;
  /** Command name for the title. Fetched when omitted (SkillPreviewModal). */
  name?: string;
  /** Extra header controls after the preview/source switch (delete, close…). */
  actions?: ReactNode;
  /** Handed to the embedded markdown preview (its own Esc / close affordance). */
  onClose?: () => void;
}

/**
 * One skill: its directory, opened on SKILL.md (DirectoryPane over
 * /api/skills/files). Shared by the skills board's right pane and
 * SkillPreviewModal.
 *
 * Mount with `key={skillId}` when the skill can change.
 */
export function SkillPreviewPane({ skillId, name, actions, onClose }: SkillPreviewPaneProps) {
  const { t } = useTranslation();
  const [fetchedName, setFetchedName] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (name) return;
    let cancelled = false;
    BrowserRuntime.runPromiseExit(loadSkillContent<{ name: string }>(skillId)).then((exit) => {
      if (!cancelled && exit._tag === 'Success') setFetchedName(exit.value.name);
    });
    return () => { cancelled = true; };
  }, [skillId, name]);

  const shownName = name ?? fetchedName;
  return (
    <DirectoryPane
      endpoint="/api/skills/files"
      id={skillId}
      entryFile="SKILL.md"
      title={shownName ? `/${shownName}` : t('skills.previewTitle')}
      actions={actions}
      onClose={onClose}
    />
  );
}
