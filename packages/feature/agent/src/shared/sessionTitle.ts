/** Cockpit-owned title metadata; native engine titles remain independent. */
export interface SessionTitleInfo {
  title: string;
  defaultTitle: string;
  customTitle: string | null;
  titleRevision: number;
}

export interface SessionTitleChange extends SessionTitleInfo {
  cwd: string;
  sessionId: string;
}

export interface SessionTitlesResponse {
  titles: SessionTitleChange[];
}

export function normalizeSessionTitle(title: string): string {
  return title.replace(/[\r\n]+/g, ' ').trim();
}
