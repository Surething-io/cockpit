export interface InitialProjectTarget {
  sessionId?: string;
  blank?: boolean;
  switchToAgent?: boolean;
}

export function buildProjectUrl(cwd: string, initial?: InitialProjectTarget): string {
  let url = `/project?cwd=${encodeURIComponent(cwd)}`;
  if (initial?.sessionId) {
    url += `&sessionId=${encodeURIComponent(initial.sessionId)}`;
    if (initial.switchToAgent) url += '&view=agent';
  } else if (initial?.blank) {
    url += '&newChat=1';
  }
  return url;
}
