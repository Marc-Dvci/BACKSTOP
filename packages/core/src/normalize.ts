/**
 * Byte-exact response normalization.
 *
 * The battery asks a question whose answer is one symbol from a committed alphabet. The
 * normalization maps the raw response bytes to an alphabet index, and its implementation
 * hash is pinned in the attestation, so every party turns the same bytes into the same
 * index.
 *
 * Order of operations, fixed:
 *   1. UTF-8 decode, replacing malformed sequences with U+FFFD
 *   2. Unicode NFKC
 *   3. strip Unicode whitespace and the ASCII punctuation set from both ends
 *   4. case-fold with the Unicode simple lowercase mapping
 *   5. first alphabet symbol that the remainder starts with, longest match first
 */

const TRIM = /^[\s"'`.,:;!?()[\]{}<>*_~-]+|[\s"'`.,:;!?()[\]{}<>*_~-]+$/gu;

export const NORMALIZATION_SPEC = "backstop/normalize@1";

export function normalizeResponse(raw: string, alphabet: readonly string[]): number | null {
  const folded = raw.normalize("NFKC").replace(TRIM, "").toLowerCase();
  if (folded.length === 0) return null;

  const order = alphabet
    .map((symbol, index) => ({ symbol: symbol.normalize("NFKC").toLowerCase(), index }))
    .sort((a, b) => b.symbol.length - a.symbol.length);

  for (const { symbol, index } of order) {
    if (folded.startsWith(symbol)) return index;
  }
  return null;
}

/** Counts over the alphabet for a batch of raw responses. Unmatched responses are reported. */
export function countResponses(
  raws: readonly string[],
  alphabet: readonly string[],
): { counts: number[]; unmatched: number } {
  const counts = new Array(alphabet.length).fill(0) as number[];
  let unmatched = 0;
  for (const r of raws) {
    const i = normalizeResponse(r, alphabet);
    if (i === null) unmatched += 1;
    else counts[i] = (counts[i] ?? 0) + 1;
  }
  return { counts, unmatched };
}
