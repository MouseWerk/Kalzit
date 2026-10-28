/**
 * The key id of an Ed25519 public key as Kalzit and `kalzit-sign` compute it: the first 8 bytes
 * of the key's SHA-256, in hex (plugin-api/src/signing.rs, `key_id`). Computed here so an
 * administrator compares it with the publisher's before the key is trusted. SHA-256 is written
 * out because `crypto.subtle` exists only on HTTPS pages and localhost, and Kalzit may be served
 * over plain HTTP inside a network.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(data: Uint8Array): Uint8Array {
  const length = data.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(block + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25);
      const ch = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const t1 = ((hh as number) + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22);
      const maj =
        ((a as number) & (b as number)) ^
        ((a as number) & (c as number)) ^
        ((b as number) & (c as number));
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) {
      h[i] = ((h[i] as number) + (next[i] as number)) >>> 0;
    }
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, h[i] as number);
  }
  return out;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The DER prefix of an Ed25519 public key in SubjectPublicKeyInfo form (`openssl pkey -pubout`). */
const SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    return null;
  }
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The 32 bytes of a public key as people paste it: 64 hex digits, base64 of the 32 bytes, or
 * base64 of the SubjectPublicKeyInfo, optionally after a label such as `kalzit-ed25519` and
 * inside PEM lines. Null for anything else.
 */
export function parsePublicKey(input: string): Uint8Array | null {
  const tokens = input
    .replace(/-----[A-Z ]+-----/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  // PEM lines belong together; otherwise the key is one of the words, usually the last.
  for (const candidate of [tokens.join(""), ...[...tokens].reverse()]) {
    const key = decodeKey(candidate);
    if (key !== null) {
      return key;
    }
  }
  return null;
}

function decodeKey(text: string): Uint8Array | null {
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  }
  const bytes = fromBase64(text);
  if (bytes === null) {
    return null;
  }
  if (bytes.length === 32) {
    return bytes;
  }
  if (bytes.length === 44 && SPKI_PREFIX.every((byte, i) => bytes[i] === byte)) {
    return bytes.slice(12);
  }
  return null;
}

/** Base64 of the 32 key bytes, the form the server stores and lists. */
export function keyBase64(key: Uint8Array): string {
  return btoa(String.fromCharCode(...key));
}

/** The key id: hex of the first 8 bytes of the key's SHA-256. */
export function keyIdOf(key: Uint8Array): string {
  return hex(sha256(key).slice(0, 8));
}

export const sha256Hex = (data: Uint8Array) => hex(sha256(data));
