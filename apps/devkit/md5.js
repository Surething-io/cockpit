/**
 * Minimal MD5, RFC 1321. Exposes a global `md5`.
 *
 * Why this file exists: MD5 is the one digest `crypto.subtle` does not offer,
 * and shelling out to `md5sum` / `md5 -q` / `openssl dgst` is a portability
 * mess (GNU vs BSD flags, differing output formats, tools missing entirely on
 * slim images) plus a ~50ms process spawn per keystroke. Fifty lines here keep
 * the app pure-computation, offline, and instant.
 *
 * md5(input) -> lowercase hex string. Accepts a string (encoded as UTF-8) or a
 * Uint8Array / ArrayBuffer of raw bytes.
 */
(function (global) {
  'use strict';

  // Per-round left-rotation amounts.
  var S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  // K[i] = floor(abs(sin(i + 1)) * 2^32); Uint32Array truncates for us.
  var K = new Uint32Array(64);
  for (var k = 0; k < 64; k++) {
    K[k] = Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296);
  }

  function rotl(x, c) {
    return ((x << c) | (x >>> (32 - c))) >>> 0;
  }

  // Little-endian hex of one 32-bit word.
  function wordToHex(x) {
    var s = '';
    for (var i = 0; i < 4; i++) {
      s += ((x >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return s;
  }

  function digest(bytes) {
    var n = bytes.length;
    // Append 0x80, pad with zeros, then an 8-byte little-endian bit length,
    // so the total is a multiple of 64.
    var padded = (n + 1 + 8 + 63) & ~63;
    var buf = new Uint8Array(padded);
    buf.set(bytes);
    buf[n] = 0x80;

    var view = new DataView(buf.buffer);
    // n * 8 stays exact well past any textarea; split across two 32-bit words.
    view.setUint32(padded - 8, (n * 8) >>> 0, true);
    view.setUint32(padded - 4, Math.floor(n / 536870912) >>> 0, true);

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    for (var off = 0; off < padded; off += 64) {
      var A = a0, B = b0, C = c0, D = d0;

      for (var i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) & 15;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) & 15;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) & 15;
        }
        F = (F + A + K[i] + view.getUint32(off + g * 4, true)) >>> 0;
        A = D;
        D = C;
        C = B;
        B = (B + rotl(F, S[i])) >>> 0;
      }

      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    return wordToHex(a0) + wordToHex(b0) + wordToHex(c0) + wordToHex(d0);
  }

  global.md5 = function md5(input) {
    if (typeof input === 'string') return digest(new TextEncoder().encode(input));
    if (input instanceof ArrayBuffer) return digest(new Uint8Array(input));
    return digest(input);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
