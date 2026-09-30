export interface InitialProjectTarget {
  sessionId?: string;
  blank?: boolean;
  switchToAgent?: boolean;
  /** Project-relative file to reveal in the Explorer on mount. */
  file?: string;
  /** Terminal bubble (commandId) to reveal in the Console on mount. */
  bubble?: string;
}

export function buildProjectUrl(cwd: string, initial?: InitialProjectTarget): string {
  let url = `/project?cwd=${encodeURIComponent(cwd)}`;
  if (initial?.sessionId) {
    url += `&sessionId=${encodeURIComponent(initial.sessionId)}`;
  } else if (initial?.blank) {
    url += '&newChat=1';
  }
  // A frozen file target also fixes the panel: revealing a file in a hidden
  // Explorer would look like nothing happened.
  if (initial?.file) {
    url += `&file=${encodeURIComponent(initial.file)}`;
  } else if (initial?.bubble) {
    url += `&bubble=${encodeURIComponent(initial.bubble)}`;
  }
  // Exactly one `view`, decided here. Both intents can be frozen on the same
  // cwd (a session link lands first, then the Bots panel opens that directory),
  // and emitting both turns `view` into a string[] on the other side, which
  // matches neither panel — the frame would open on whatever it last saved.
  // The file target wins: it is the more specific request of the two.
  const view = initial?.file
    ? 'explorer'
    : initial?.bubble
      ? 'console'
      : initial?.sessionId && initial.switchToAgent ? 'agent' : null;
  if (view) url += `&view=${view}`;
  return url;
}
