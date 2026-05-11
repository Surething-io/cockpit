'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  currentName: string;
  onConfirm: (name: string) => void;
  onSkip: () => void;
}

export function NicknameModal({ currentName, onConfirm, onSkip }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(currentName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus and select all
    inputRef.current?.select();
  }, []);

  const handleConfirm = () => {
    const trimmed = name.trim();
    if (trimmed) {
      onConfirm(trimmed);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-80 p-5">
        <h2 className="text-base font-semibold mb-1">{t('review.setNickname')}</h2>
        <p className="text-xs text-muted-foreground mb-4">
          {t('review.nicknameHint')}
        </p>

        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleConfirm();
            if (e.key === 'Escape') onSkip();
          }}
          placeholder={t('review.nicknamePlaceholder')}
          maxLength={20}
          className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-brand"
          autoFocus
        />

        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            onClick={onSkip}
            className="px-3 py-1.5 text-xs rounded-lg hover:bg-accent transition-colors text-muted-foreground"
          >
            {t('review.skipForNow')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!name.trim()}
            className="px-4 py-1.5 text-xs rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-40"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
