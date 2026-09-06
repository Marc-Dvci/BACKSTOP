/**
 * The reference pool and its two partitions.
 *
 * For each element c of the mixture set M and each cell j the issuer generates i.i.d. draws
 * locally, by running the declared configuration mixture against weights it holds, and
 * partitions them once at issuance:
 *
 *   fingerprint partition  P_R(c,j)  ->  n_R draws, estimates the comparison fingerprint R(c,j)
 *   calibration partition  P_C(c,j)  ->  m * T_max blocks of n draws, one block per statistic
 *
 * The partitions never overlap. R(c,j) is computed from the fingerprint partition alone and
 * is therefore a constant with respect to every calibration block and every audited round,
 * which is what makes the m + 1 statistics exchangeable.
 *
 * Only the Merkle root is committed at issuance. Each round's calibration slice is revealed
 * after the round seals, so the slice is never in the filtration the round conditions on.
 */

import { MerkleTree, hashLeaf } from "./merkle.js";
import { concatBytes, keccakString, word, utf8, fromHex, type Hex } from "./hash.js";
import { Prng } from "./prng.js";
import { empirical, type Distribution } from "./stats.js";

/** A block of draws, stored as counts over the cell's committed answer alphabet. */
export type Counts = readonly number[];

export interface CellPool {
  elementId: string;
  cellId: string;
  /** Counts over the whole fingerprint partition. */
  fingerprint: Counts;
  /** m * T_max blocks, each the counts of n draws. */
  calibration: Counts[];
}

export interface ReferencePool {
  attestationVersion: number;
  alphabetSize: number;
  n: number;
  nR: number;
  m: number;
  tMax: number;
  cells: CellPool[];
}

/** Leaf encoding for the fingerprint partition of one (element, cell). */
export function fingerprintLeaf(elementId: string, cellId: string, counts: Counts): Hex {
  return hashLeaf(
    concatBytes(
      utf8("BACKSTOP/pool/fingerprint@1"),
      fromHex(keccakString(elementId)),
      fromHex(keccakString(cellId)),
      ...counts.map((c) => word(c)),
    ),
  );
}

/** Leaf encoding for one calibration block. */
export function calibrationLeaf(
  elementId: string,
  cellId: string,
  blockIndex: number,
  counts: Counts,
): Hex {
  return hashLeaf(
    concatBytes(
      utf8("BACKSTOP/pool/calibration@1"),
      fromHex(keccakString(elementId)),
      fromHex(keccakString(cellId)),
      word(blockIndex),
      ...counts.map((c) => word(c)),
    ),
  );
}

/** Every leaf of the pool, in the canonical order the tree is built in. */
export function poolLeaves(pool: ReferencePool): Hex[] {
  const leaves: Hex[] = [];
  for (const c of pool.cells) {
    leaves.push(fingerprintLeaf(c.elementId, c.cellId, c.fingerprint));
    c.calibration.forEach((counts, i) => {
      leaves.push(calibrationLeaf(c.elementId, c.cellId, i, counts));
    });
  }
  return leaves;
}

export function poolTree(pool: ReferencePool): MerkleTree {
  return new MerkleTree(poolLeaves(pool));
}

export function poolRoot(pool: ReferencePool): Hex {
  return poolTree(pool).root;
}

/**
 * The per-round calibration slice schedule.
 *
 * For each (element, cell) the blocks are permuted once, deterministically from the pool
 * root, and round t consumes positions [t*m, (t+1)*m). Disjointness across rounds is
 * structural, and every party derives the same schedule from public data.
 */
export function sliceSchedule(
  poolRootHash: Hex,
  elementId: string,
  cellId: string,
  m: number,
  tMax: number,
): number[][] {
  const seed = keccakString(`${poolRootHash}|${elementId}|${cellId}|slice@1`);
  const perm = new Prng(seed).permutation(m * tMax);
  const out: number[][] = [];
  for (let t = 0; t < tMax; t++) out.push(perm.slice(t * m, (t + 1) * m));
  return out;
}

/** R(c,j), the comparison fingerprint, from the fingerprint partition alone. */
export function fingerprintDistribution(cell: CellPool): Distribution {
  return empirical(cell.fingerprint);
}

export function findCell(pool: ReferencePool, elementId: string, cellId: string): CellPool {
  const c = pool.cells.find((x) => x.elementId === elementId && x.cellId === cellId);
  if (!c) throw new Error(`reference pool has no cell ${cellId} for element ${elementId}`);
  return c;
}
