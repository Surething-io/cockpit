/**
 * Shared shortId utility: deterministic CRC32 → 4-character [a-z] mapping.
 *
 * Used by BrowserBridge and TerminalBridge to avoid duplicate implementations.
 */

export function crc32(str: string): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function toShortId(fullId: string): string {
  const hash = crc32(fullId);
  let id = '';
  let val = hash;
  for (let i = 0; i < 4; i++) {
    id += String.fromCharCode(97 + (val % 26)); // a-z
    val = Math.floor(val / 26);
  }
  return id;
}
