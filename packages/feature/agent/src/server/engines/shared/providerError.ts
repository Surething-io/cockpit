/**
 * Turning a provider failure into one sentence a user can act on.
 *
 * The actionable text is rarely in `error.message` alone. The AI SDK's
 * APICallError carries the HTTP status in `statusCode` and the provider's own
 * wording in `responseBody` — e.g. Kimi answers a 401 with
 * `{"error":{"message":"Your current subscription does not have access to k3.
 * Upgrade to higher-tier Kimi Code plans..."}}`. Emitting only `.message`
 * (orchestrator.ts) or dropping the error entirely (builtinAgent/stream.ts)
 * left the UI with a blank bubble and the reason stranded in the server log.
 *
 * Used by every engine path, so it must stay defensive: any shape in, a
 * non-empty string out.
 */

/** Pull the human sentence out of a provider's JSON (or plain-text) error body. */
function extractBodyMessage(body: unknown): string | undefined {
  if (typeof body !== 'string' || !body.trim()) return undefined;

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = parsed.error;
    if (err && typeof err === 'object') {
      const message = (err as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
    if (typeof err === 'string' && err.trim()) return err.trim();
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
    return undefined;
  } catch {
    // Not JSON: a proxy's HTML error page or plain text. Keep it only if it is
    // short enough to read as a message rather than a document.
    const text = body.trim();
    return text.length <= 300 ? text : undefined;
  }
}

export function formatProviderError(error: unknown): string {
  if (error === null || error === undefined) return 'Unknown error';
  if (typeof error === 'string') return error.trim() || 'Unknown error';
  if (typeof error !== 'object') return String(error);

  const e = error as { message?: unknown; statusCode?: unknown; responseBody?: unknown };

  const base = typeof e.message === 'string' ? e.message.trim() : '';
  const fromBody = extractBodyMessage(e.responseBody);
  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;

  // The SDK often lifts the body message into `.message` already — only append
  // when it genuinely adds something.
  let text: string;
  if (fromBody && base && !base.includes(fromBody)) text = `${base} — ${fromBody}`;
  else text = fromBody || base;

  if (!text) {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
    if (!text || text === '{}') text = 'Request failed';
  }

  return status ? `[HTTP ${status}] ${text}` : text;
}
