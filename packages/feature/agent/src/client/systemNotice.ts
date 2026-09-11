import i18n from '@cockpit/shared-i18n';
import type { ChatMessage } from './types';
import type { StreamEvent } from './applyStreamEvent';

/**
 * `system/notice` → the muted one-line system row (MessageBubble renders every
 * `role:'system'` message that way; `kind:'meta'` is the non-task flavour).
 *
 * An engine-level advisory about the RUN, not about the model's output: the
 * turn still happened, but something the user did not ask for changed under it.
 * Shared by the originator (useChatStream) and the viewer (useLiveStream) so
 * the two cannot word the same event differently.
 *
 * Live-only by design — nothing writes it to a transcript, so it is gone after
 * a reload. That is the same deal as the retry / rate-limit indicators: it
 * explains a moment, and the state it describes (a new session id) is visible
 * on its own afterwards.
 *
 * `content` is the one-line bar, `systemEvent.detail` the modal body. Unknown
 * notice kinds return null rather than rendering an empty bar — a newer server
 * talking to an older client should say nothing, not say blank.
 */
export function buildNoticeMessage(ev: StreamEvent, id: string): ChatMessage | null {
  if (ev.notice !== 'codex_resume_failed') return null;

  const previous = ev.previous_session_id || '';
  const content = i18n.t('chat.codexResumeFailed', {
    defaultValue: 'Previous session is in use by another Codex client — started a new session; history was not carried over',
  });
  // Each block is prefixed by its own blank line rather than separated by a
  // trailing one, so an event that carries only the headline renders as the
  // headline — no empty tail in the modal.
  const ids = [
    ...(previous ? [`${i18n.t('chat.codexResumeFailedPrevious', { defaultValue: 'Previous session' })}: ${previous}`] : []),
    ...(ev.session_id ? [`${i18n.t('chat.codexResumeFailedNew', { defaultValue: 'New session' })}: ${ev.session_id}`] : []),
  ];
  const detail = [
    content,
    ...(ids.length ? ['', ...ids] : []),
    ...(ev.error ? ['', ev.error] : []),
  ].join('\n');

  return { id, role: 'system', content, systemEvent: { kind: 'meta', detail } } as ChatMessage;
}
