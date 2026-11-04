/** A favorite owns membership/order; its displayed title comes from the session. */
export interface PinnedSession {
  sessionId: string;
  cwd: string;
  title?: string;
  /** Read only while migrating old favorite snapshots. Never written by new clients. */
  customTitle?: string;
}
