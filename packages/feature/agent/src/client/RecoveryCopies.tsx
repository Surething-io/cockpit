'use client';

import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryFailure } from './chatHistoryState';

/** Read-only recovery data never enters message navigation, fork or transcript editing. */
const RecoveryCopy = memo(function RecoveryCopy({ copy, onDismiss }: { copy: HistoryFailure; onDismiss?: (id: string) => void }) {
  const { t } = useTranslation();
  const text = useMemo(() => copy.messages.map((message) => [
    `[${message.role}]`, message.content,
    message.systemEvent?.detail !== message.content ? message.systemEvent?.detail : undefined,
    message.streamError && !message.content.includes(message.streamError) ? message.streamError : undefined,
    ...(message.toolCalls ?? []).map((tool) => JSON.stringify(tool, null, 2)),
  ].filter(Boolean).join('\n')).join('\n\n'), [copy.messages]);
  const dismiss = useCallback(() => onDismiss?.(copy.id), [onDismiss, copy.id]);
  // A one-line muted strip until opened: it is a safety net, not news, and it
  // sits above the whole conversation for as long as the tab stays open.
  return <div className="flex items-start gap-1 text-xs">
    <details className="min-w-0 flex-1" data-recovery-id={copy.id}>
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        {t('chat.recoveryCopy')}
        {' · '}{new Date(copy.startedAt).toLocaleTimeString()}
      </summary>
      <p className="my-2 text-muted-foreground">
        {t('chat.recoveryCopyHint')}
      </p>
      <pre className="whitespace-pre-wrap break-words select-text">{text}</pre>
      {copy.messages.flatMap((message) => (message.images ?? []).map((image, index) => (
        // Recovery images have no transcript action controls.
        <img key={`${message.id}-${index}`} src={`data:${image.media_type};base64,${image.data}`} alt={t('chat.recoveryAttachment')} className="mt-2 max-h-40 max-w-full object-contain" />
      )))}
    </details>
    {onDismiss && (
      <button type="button" onClick={dismiss} aria-label={t('common.close')} title={t('common.close')}
        className="shrink-0 rounded px-1 leading-4 text-muted-foreground hover:bg-accent hover:text-foreground">
        ×
      </button>
    )}
  </div>;
});

export const RecoveryCopies = memo(function RecoveryCopies({ copies, onDismiss }: { copies: HistoryFailure[]; onDismiss?: (id: string) => void }) {
  const { t } = useTranslation();
  if (!copies.length) return null;
  return <aside aria-label={t('chat.recoveryCopiesLabel')} className="max-h-64 shrink-0 overflow-y-auto space-y-1 px-4 py-1 border-b border-border">
    {copies.map((copy) => <RecoveryCopy key={copy.id} copy={copy} onDismiss={onDismiss} />)}
  </aside>;
});
