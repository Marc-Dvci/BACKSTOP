/** Version identifiers hashed into every attestation, so a verdict names the code that produced it. */

import { keccakString, type Hex } from "./hash.js";

export const CORE_VERSION = "1.0.0";

/**
 * The canonical arithmetic spec hash. It covers the representation, the rounding mode, the
 * series lengths and the domain bounds of BSA-1. The Solidity library asserts the same
 * constant, so a change on either side breaks the attestation reference rather than
 * silently changing a verdict.
 */
export const CANONICAL_ARITHMETIC_SPEC =
  "BSA-1|scale=1e27|round=trunc-toward-zero|ln=atanh-10-tab16|exp=taylor-25|ln2=693147180559945309417232121|expmax=88";

export const CANONICAL_ARITHMETIC_HASH: Hex = keccakString(CANONICAL_ARITHMETIC_SPEC);

export const NORMALIZATION_SPEC_STRING =
  "backstop/normalize@1|nfkc|trim-ws-punct|simple-lowercase|longest-prefix-match";

export const NORMALIZATION_IMPL_HASH: Hex = keccakString(NORMALIZATION_SPEC_STRING);
