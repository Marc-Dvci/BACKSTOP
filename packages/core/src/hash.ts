/** Keccak-256 helpers and the canonical byte encodings the protocol commits to. */

import { keccak_256 } from "@noble/hashes/sha3";

export type Hex = `0x${string}`;

export function toHex(bytes: Uint8Array): Hex {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `0x${s}` as Hex;
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("odd-length hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function keccak(data: Uint8Array): Hex {
  return toHex(keccak_256(data));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A 32-byte big-endian encoding of an unsigned integer, matching `abi.encode(uint256)`. */
export function word(value: bigint | number): Uint8Array {
  let v = BigInt(value);
  if (v < 0n) v = (1n << 256n) + v; // two's complement, matching `abi.encode(int256)`
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** A 32-byte value parsed from hex, rejecting anything of the wrong width. */
export function word32(hex: string): Uint8Array {
  const b = fromHex(hex);
  if (b.length !== 32) throw new Error(`expected a 32-byte value, received ${b.length}`);
  return b;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** keccak256 of a UTF-8 string, matching `keccak256(bytes(s))`. */
export function keccakString(s: string): Hex {
  return keccak(utf8(s));
}

/**
 * Canonical JSON: object keys sorted lexicographically by UTF-16 code unit, no insignificant
 * whitespace, bigints rendered as decimal strings. Two implementations that agree on the
 * object agree on the bytes, so the digest is portable.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue;
      out[k] = canonicalise(src[k]);
    }
    return out;
  }
  return value;
}

/** The digest of any protocol object: keccak256 over its canonical JSON encoding. */
export function digest(value: unknown): Hex {
  return keccakString(canonicalJson(value));
}
