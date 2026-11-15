import type { CodeIndex } from '../../codeMap/projectGraph/codeIndex';

/** Add completeness metadata without changing existing JSON/plain payloads. */
export function withIndexHeaders(index: CodeIndex, response: Response): Response {
  response.headers.set('X-Code-Index-Revision', String(index.revision ?? 0));
  response.headers.set('X-Code-Index-Incomplete', index.truncated ? '1' : '0');
  return response;
}

export function indexResponse(index: CodeIndex, value: unknown): Response {
  return withIndexHeaders(index, new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  }));
}
