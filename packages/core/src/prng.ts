/**
 * A deterministic counter-mode PRNG over Keccak-256.
 *
 * Used wherever the protocol needs reproducible pseudo-randomness that every party derives
 * for itself: the calibration slice schedule, cell selection, and producer assignment. Any
 * implementation that agrees on the seed agrees on the whole stream.
 */

import { keccak, concatBytes, fromHex, word, type Hex } from "./hash.js";

export class Prng {
  private counter = 0n;
  private buffer: Uint8Array = new Uint8Array(0);
  private offset = 0;

  constructor(private readonly seed: Hex) {}

  private refill(): void {
    this.buffer = fromHex(keccak(concatBytes(fromHex(this.seed), word(this.counter))));
    this.counter += 1n;
    this.offset = 0;
  }

  /** The next 32-bit unsigned value from the stream. */
  nextU32(): number {
    if (this.offset + 4 > this.buffer.length) this.refill();
    const b = this.buffer;
    const o = this.offset;
    this.offset += 4;
    return (((b[o] ?? 0) << 24) >>> 0) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0);
  }

  /** A uniform integer in [0, bound), rejection-sampled so the distribution is exact. */
  nextBelow(bound: number): number {
    if (bound <= 0) throw new Error("bound must be positive");
    const limit = Math.floor(0x100000000 / bound) * bound;
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % bound;
    }
  }

  /** A Fisher-Yates permutation of [0, n), drawn from this stream. */
  permutation(n: number): number[] {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = this.nextBelow(i + 1);
      const tmp = a[i] as number;
      a[i] = a[j] as number;
      a[j] = tmp;
    }
    return a;
  }

  /** A uniform sample of `k` distinct values from [0, n), in permutation order. */
  sample(n: number, k: number): number[] {
    if (k > n) throw new Error("sample larger than population");
    return this.permutation(n).slice(0, k);
  }
}
