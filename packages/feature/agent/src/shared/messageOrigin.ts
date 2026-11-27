/**
 * The origin line a message sent by ANOTHER session carries, written and read in one place
 * so the two can never drift:
 *
 *   `@<session Bot> <task>` → `[Sent from Cockpit session <link> (<project>) via @mention]`
 *                             (first line; `[Sent via @mention from another Cockpit session]`
 *                             when the sender could not be identified)
 *   `/dl`, `@bot`           → `[Delegated from Cockpit session <link> (<project>)]`
 *                             (after the `Task: <title>` line a delegated session opens with)
 *
 * The line stays in the transcript verbatim — it is how the receiving MODEL knows the message
 * is not from the person at the keyboard. Only the chat bubble turns it into a small
 * "from <project> <session>" label above the message (MessageBubble).
 */

/**
 * `inputId` makes the line identify THIS message in the receiving transcript, so a waiting
 * sender can find its own message and the reply to it (delegation status with `inputId`) —
 * instead of reading whatever the session last finished. The bubble never shows it.
 */
export function sentOriginLine(link: string | null, project: string, inputId?: string): string {
  const id = inputId ? ` · input ${inputId}` : '';
  return link
    ? `[Sent from Cockpit session ${link} (${project}) via @mention${id}]`
    : `[Sent via @mention from another Cockpit session${id}]`;
}

export function delegatedOriginLine(link: string, project: string): string {
  return `[Delegated from Cockpit session ${link} (${project})]`;
}

export interface MessageOrigin {
  kind: 'sent' | 'delegated';
  /** The sending session's link (`/project?…`), when known. */
  link: string | null;
  /** The sending session's project name, when known. */
  project: string | null;
  /** The message with the origin line (and the blank line after it) removed. */
  body: string;
  /** The sender's identity for this message (sentOriginLine), when it carried one. */
  inputId?: string;
}

const SENT = /^\[Sent from Cockpit session (\/project\?\S+) \((.*)\) via @mention(?: · input ([\w-]+))?\]$/;
const SENT_ANONYMOUS = /^\[Sent via @mention from another Cockpit session(?: · input ([\w-]+))?\]$/;
const DELEGATED = /^\[Delegated from Cockpit session (\/project\?\S+) \((.*)\)\]$/;

/** The origin of a user turn written by another session, or null for an ordinary message. */
export function parseMessageOrigin(text: string): MessageOrigin | null {
  const lines = text.split('\n');
  // Sent: always the first line. Delegated: the second, under `Task: <title>`.
  const first = lines[0] ?? '';
  const sent = first.match(SENT);
  const anonymous = sent ? null : first.match(SENT_ANONYMOUS);
  if (sent || anonymous) {
    const inputId = sent?.[3] ?? anonymous?.[1];
    return {
      kind: 'sent',
      link: sent?.[1] ?? null,
      project: sent?.[2] ?? null,
      body: lines.slice(1).join('\n').replace(/^\n+/, ''),
      ...(inputId && { inputId }),
    };
  }
  const index = lines.findIndex((line, i) => i <= 1 && DELEGATED.test(line));
  if (index === -1) return null;
  const delegated = lines[index].match(DELEGATED)!;
  return {
    kind: 'delegated',
    link: delegated[1],
    project: delegated[2],
    body: [...lines.slice(0, index), ...lines.slice(index + 1)].join('\n').replace(/^\n+/, ''),
  };
}
