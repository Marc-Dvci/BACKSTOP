/**
 * Sorted-pair Keccak Merkle trees, byte-compatible with OpenZeppelin `MerkleProof`.
 *
 * Leaves are hashed twice so that no internal node can be presented as a leaf. Sibling
 * pairs are sorted before hashing, so a proof carries no direction bits and verification
 * onchain is a single loop.
 */

import { keccak, concatBytes, fromHex, type Hex } from "./hash.js";

export function hashLeaf(encoded: Uint8Array): Hex {
  return keccak(fromHex(keccak(encoded)));
}

function hashPair(a: Hex, b: Hex): Hex {
  const x = fromHex(a);
  const y = fromHex(b);
  const aFirst = compare(x, y) <= 0;
  return keccak(aFirst ? concatBytes(x, y) : concatBytes(y, x));
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export class MerkleTree {
  readonly leaves: Hex[];
  private readonly layers: Hex[][];

  constructor(leaves: Hex[]) {
    if (leaves.length === 0) throw new Error("Merkle tree over an empty leaf set");
    this.leaves = leaves;
    this.layers = [leaves];
    let current = leaves;
    while (current.length > 1) {
      const next: Hex[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const l = current[i] as Hex;
        const r = current[i + 1];
        next.push(r === undefined ? l : hashPair(l, r));
      }
      this.layers.push(next);
      current = next;
    }
  }

  get root(): Hex {
    const top = this.layers[this.layers.length - 1] as Hex[];
    return top[0] as Hex;
  }

  proof(index: number): Hex[] {
    if (index < 0 || index >= this.leaves.length) throw new Error("leaf index out of range");
    const out: Hex[] = [];
    let idx = index;
    for (let d = 0; d < this.layers.length - 1; d++) {
      const layer = this.layers[d] as Hex[];
      const sibling = idx % 2 === 0 ? layer[idx + 1] : layer[idx - 1];
      if (sibling !== undefined) out.push(sibling);
      idx = Math.floor(idx / 2);
    }
    return out;
  }
}

export function verifyProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let node = leaf;
  for (const p of proof) node = hashPair(node, p);
  return node.toLowerCase() === root.toLowerCase();
}
