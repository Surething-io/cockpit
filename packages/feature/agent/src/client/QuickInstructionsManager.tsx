'use client';

import { useCallback, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Portal, useEscToClose } from '@cockpit/shared-ui';
import type { InstructionNode } from './effect/agentClient';
import { formatInstructionsMarkdown, parseInstructionsMarkdown } from './quickInstructionsMarkdown';

// Shared by the textarea and its mirror; any drift in font, padding or wrapping
// rules desynchronises the line numbers from the text.
const EDITOR_TEXT = 'm-0 border-0 pl-12 pr-3 py-2 text-sm font-mono leading-6 whitespace-pre-wrap break-words';

export function QuickInstructionsManager({
  title,
  nodes,
  onSave,
  onClose,
}: {
  title: string;
  nodes: InstructionNode[];
  onSave: (nodes: InstructionNode[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => formatInstructionsMarkdown(nodes));
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const parsed = parseInstructionsMarkdown(text);
  const lines = useMemo(() => text.split('\n'), [text]);

  useEscToClose(onClose);

  const save = useCallback(async () => {
    const result = parseInstructionsMarkdown(text);
    if (!result.ok || saving) return;
    setSaving(true);
    setSaveFailed(false);
    const saved = await onSave(result.nodes);
    if (saved) {
      onClose();
      return;
    }
    setSaving(false);
    setSaveFailed(true);
  }, [onClose, onSave, saving, text]);

  return (
    <Portal>
      <div
        data-quick-instruction-layer=""
        className="fixed inset-0 z-[300] flex items-center justify-center bg-scrim p-4"
        onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="w-full max-w-4xl max-h-[90vh] bg-card border border-border rounded-xl shadow-lv3 flex flex-col"
        >
          <header className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div>
              <h2 className="text-sm font-medium text-foreground">{title}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('chat.quickInstructionsMarkdownHint')}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-hover rounded"
              aria-label={t('common.cancel')}
            >
              <X className="w-4 h-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 px-4 py-3">
            {/* Soft-wrapped continuation rows look identical to new records, but
                in this outline every physical line IS one instruction. An in-flow
                mirror renders the same text invisibly, one block per logical line,
                so it wraps exactly like the textarea laid over it and can number
                each record once — continuation rows get no number. The textarea
                grows to the mirror's height and the outer box does the scrolling,
                so neither side has its own scrollbar skewing the wrap width. */}
            <div className="h-[60vh] min-h-80 overflow-y-auto bg-background border border-border rounded-lg focus-within:border-brand">
              <div className="relative min-h-full">
                <div aria-hidden="true" className={`${EDITOR_TEXT} pointer-events-none select-none text-transparent`}>
                  {lines.map((line, index) => (
                    <div key={index} className="relative">
                      <span className="absolute -left-10 w-7 text-right text-muted-foreground/50 tabular-nums">
                        {index + 1}
                      </span>
                      {line || ' '}
                    </div>
                  ))}
                </div>
                <textarea
                  autoFocus
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={t('chat.quickInstructionsMarkdownPlaceholder')}
                  spellCheck={false}
                  className={`${EDITOR_TEXT} absolute inset-0 w-full h-full resize-none overflow-hidden bg-transparent text-foreground focus:outline-none`}
                />
              </div>
            </div>
          </div>

          <footer className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border">
            <span className="text-xs text-destructive">
              {!parsed.ok
                ? t('chat.quickInstructionsMarkdownError', { line: parsed.line })
                : saveFailed ? t('chat.saveQuickInstructionsFailed') : ''}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded hover:bg-hover"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={!parsed.ok || saving}
                onClick={save}
                className="px-3 py-1.5 text-xs rounded border border-brand text-brand hover:bg-brand/10 disabled:opacity-40"
              >
                {saving ? t('chat.savingQuickInstructions') : t('common.save')}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
