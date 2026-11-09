'use client';

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryFailure } from './chatHistoryState';

/** Read-only recovery data never enters message navigation, fork or transcript editing. */
const RecoveryCopy = memo(function RecoveryCopy({ copy }: { copy: HistoryFailure }) {
  const { t } = useTranslation();
  const text = useMemo(() => copy.messages.map((message) => [
    `[${message.role}]`, message.content,
    message.systemEvent?.detail !== message.content ? message.systemEvent?.detail : undefined,
    message.streamError && !message.content.includes(message.streamError) ? message.streamError : undefined,
    ...(message.toolCalls ?? []).map((tool) => JSON.stringify(tool, null, 2)),
  ].filter(Boolean).join('\n')).join('\n\n'), [copy.messages]);
  return <details className="rounded border border-amber-500/30 p-2 text-sm" data-recovery-id={copy.id}>
    <summary className="cursor-pointer text-amber-700 dark:text-amber-300">
      {t('chat.recoveryCopy')}
      {' · '}{new Date(copy.startedAt).toLocaleTimeString()}
    </summary>
    <p className="my-2 text-xs text-muted-foreground">
      {t('chat.recoveryCopyHint')}
    </p>
    <pre className="whitespace-pre-wrap break-words select-text text-xs">{text}</pre>
    {copy.messages.flatMap((message) => (message.images ?? []).map((image, index) => (
      // Recovery images have no transcript action controls.
      <img key={`${message.id}-${index}`} src={`data:${image.media_type};base64,${image.data}`} alt={t('chat.recoveryAttachment')} className="mt-2 max-h-40 max-w-full object-contain" />
    )))}
  </details>;
});

export const RecoveryCopies = memo(function RecoveryCopies({ copies }: { copies: HistoryFailure[] }) {
  const { t } = useTranslation();
  if (!copies.length) return null;
  return <aside aria-label={t('chat.recoveryCopiesLabel')} className="max-h-64 shrink-0 overflow-y-auto space-y-2 px-4 py-2 border-b border-border">
    {copies.map((copy) => <RecoveryCopy key={copy.id} copy={copy} />)}
  </aside>;
});
