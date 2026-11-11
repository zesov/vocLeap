/**
 * UUIDv7 (RFC 9562): 48-bit big-endian millisecond timestamp followed by
 * random bits, so IDs sort by creation time and index well in SQLite.
 *
 * Works in Node (scripts, server) and in browsers/workers, both of which
 * expose `globalThis.crypto.getRandomValues`.
 */
const HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0")
);

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

let lastMs = -1;
let sequence = 0;

/** 12-bit counter so IDs created in the same millisecond still sort by call order. */
function nextSequence(now: number): number {
  if (now === lastMs) {
    sequence = (sequence + 1) & 0x0fff;
  } else {
    lastMs = now;
    const random = randomBytes(2);
    sequence = ((random[0] << 4) | (random[1] & 0x0f)) & 0x0fff;
  }
  return sequence;
}

export function uuidv7(): string {
  const bytes = randomBytes(16);
  const now = Date.now();
  const seq = nextSequence(now);

  // 48-bit timestamp, most significant byte first.
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7 (high nibble of byte 6), monotonic counter in the low nibble of
  // byte 6 and all of byte 7, then the RFC 4122 variant (byte 8).
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return (
    HEX[bytes[0]] + HEX[bytes[1]] + HEX[bytes[2]] + HEX[bytes[3]] + "-" +
    HEX[bytes[4]] + HEX[bytes[5]] + "-" +
    HEX[bytes[6]] + HEX[bytes[7]] + "-" +
    HEX[bytes[8]] + HEX[bytes[9]] + "-" +
    HEX[bytes[10]] + HEX[bytes[11]] + HEX[bytes[12]] +
    HEX[bytes[13]] + HEX[bytes[14]] + HEX[bytes[15]]
  );
}
