// Chrome Native Messaging framing: each message is a 32-bit length in native
// byte order (little-endian on every platform Chrome ships on) followed by
// UTF-8 JSON. Messages from the host to the browser are capped at 1 MB.

export const MAX_HOST_TO_BROWSER = 1024 * 1024;

export function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder. Feed it stdin chunks; it calls onMessage for every
 * complete frame and keeps any partial tail for the next chunk.
 */
export function createDecoder(onMessage, onError = () => {}) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (err) {
        onError(err);
      }
    }
  };
}
