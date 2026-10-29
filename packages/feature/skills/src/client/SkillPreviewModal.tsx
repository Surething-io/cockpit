'use client';

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { blurActiveElement } from '@cockpit/shared-ui';
import { SkillPreviewPane } from './SkillPreviewPane';

interface SkillPreviewModalProps {
  skillId: string;
  onClose: () => void;
}

/**
 * A skill's SKILL.md in a dialog of its own — for callers outside the skills
 * board. The board itself shows the same SkillPreviewPane inline.
 */
export function SkillPreviewModal({ skillId, onClose }: SkillPreviewModalProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // Blur the trigger so it doesn't keep a stuck focus ring after ESC.
        blurActiveElement();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-scrim" onClick={onClose} />

      <div className="relative bg-card rounded-lg shadow-lv3 w-full max-w-[70%] h-[90vh] mx-4 flex flex-col overflow-hidden">
        <SkillPreviewPane
          skillId={skillId}
          onClose={onClose}
          actions={
            <button
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors flex-shrink-0"
              title={t('common.close')}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          }
        />
      </div>
    </div>
  );
}
