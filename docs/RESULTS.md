# Measured results

Every number BACKSTOP publishes is produced by the code in this repository. This file is the
index: what was measured, what it says, and the one command that regenerates it.

Raw run output and machine-readable results are in `docs/results/`.

---

## Gate zero: the lifetime Type-I bound

`make gate-zero` · `docs/results/gate-zero.json`

The design is gated on this before any financial contract exists. Ville's inequality gives
`P(∃T ≤ T_max : M(T) ≥ 1/α) ≤ α`, and the campaign measures the realised lifetime crossing rate
against nominal α under a known null.

| Endpoint serves | Crossings | Realised | 95% CI | Nominal α |
|---|---:|---:|---|---:|
| a vertex of M | 0 / 4,000 | 0.0000 | [0.0000, 0.0010] | 0.05 |
| a mixture element of M | 0 / 4,000 | 0.0000 | [0.0000, 0.0010] | 0.05 |
| the second vertex of M | 0 / 4,000 | 0.0000 | [0.0000, 0.0010] | 0.05 |

12,000 trials across 40 independently generated reference pools. m = 99, n = 64, T_max = 40,
8 cells, |M| = 3.

The result is conservative rather than tight, and two design choices put it there: the e-value is
the minimum over the whole mixture set, and the rank p-value has a floor of `1/(m+1)`. Both trade
power for validity that holds uniformly over the composite null.

---

## Benign versus substitution

`make bench` · `docs/results/bench.json`

| Scenario | Crossings | Median delay |
|---|---:|---:|
| serves cfg-a throughout | 0 / 200 | — |
| serves cfg-b throughout | 0 / 200 | — |
| serves mix-50 throughout | 0 / 200 | — |
| cfg-a to cfg-b at round 10 | 0 / 200 | — |
| cfg-b to mix-50 at round 15 | 0 / 200 | — |
| alternates cfg-a and cfg-b | 0 / 200 | — |
| mix-50 to cfg-a at round 5 | 0 / 200 | — |
| per-cell rotation across the envelope | 0 / 200 | — |
| **full substitution** | **200 / 200** | 8 |
| **dilution ε = 0.5** | **200 / 200** | 8 |
| **dilution ε = 0.3** | **200 / 200** | 11 |
| **dilution ε = 0.2** | **200 / 200** | 17 |

**0 of 1,600 benign, every departure at ε ≥ 0.2 at power 1.000**, at 512 single-token queries per
round.

### Detection delay against α and departure size

| α | ε | Power | Mean delay | Median |
|---:|---:|---:|---:|---:|
| 0.01 | 1.0 | 1.000 | 5.8 | 6 |
| 0.01 | 0.5 | 1.000 | 6.6 | 7 |
| 0.01 | 0.3 | 1.000 | 8.3 | 8 |
| 0.05 | 1.0 | 1.000 | 4.8 | 5 |
| 0.05 | 0.5 | 1.000 | 5.0 | 5 |
| 0.05 | 0.3 | 1.000 | 5.7 | 6 |
| 0.10 | 1.0 | 1.000 | 4.0 | 4 |
| 0.10 | 0.5 | 1.000 | 4.1 | 4 |
| 0.10 | 0.3 | 1.000 | 5.2 | 5 |

This is the curve the quote function reads for `P(detected while eligible | departure)`.

---

## The detection floor is a sample-size dial

`make bench` · `docs/results/bench-scaling.json`

A probe costs one output token, so draws per cell are the cheapest lever the protocol has. An
attestation is sized against the dilution its buyer wants covered, before coverage is written.

| ε | Draws per cell | Queries per round | Power | Median delay | Benign crossings |
|---:|---:|---:|---:|---:|---:|
| 0.10 | 64 | 512 | 0.000 | — | 0 / 60 |
| 0.10 | 128 | 1,024 | 0.983 | 20 | 0 / 60 |
| 0.10 | 256 | 2,048 | 1.000 | 10 | 0 / 60 |
| 0.10 | 512 | 4,096 | 1.000 | 6 | 0 / 60 |
| 0.05 | 512 | 4,096 | 1.000 | 19 | 0 / 60 |

The false-alarm control holds at every sample size.

---

## Envelope width, on a real model

`make harness` · `docs/results/envelope.json`

Qwen3-1.7B run locally through the probe battery at three quantisations. Q8_0 is a declared
element of the envelope; Q4_K_M is the substitution the settlement tier is written against.

20,000 draws per cell per configuration, 480,000 completions in 79 minutes on one RTX 4070.

| Cell | JSD(BF16, Q8_0) | JSD(BF16, Q4_K_M) | Separation |
|---|---:|---:|---:|
| `digit.en` | 0.004058 | 0.037632 | 9.27× |
| `digit.fr` | 0.001887 | 0.034649 | 18.36× |
| `digit.es` | 0.005268 | 0.031362 | 5.95× |
| `digit.zh` | 0.001972 | 0.015969 | 8.10× |
| `letter.en` | 0.003301 | 0.064968 | 19.68× |
| `letter.fr` | 0.000708 | 0.009435 | 13.33× |
| `letter.es` | 0.001131 | 0.028736 | 25.41× |
| `letter.zh` | 0.001063 | 0.004462 | 4.20× |
| **mean** | **0.002423** | **0.028402** | **11.72×** |

The separation is what decides whether the settlement tier applies to a model at all. On
`letter.en` the mode of the answer distribution flips outright between BF16 and Q4_K_M.

### Caught live

| Endpoint served | Result | Exit |
|---|---|---:|
| BF16, the attested precision | 6 rounds, log M → −1.28, consistent | 0 |
| Q4_K_M, substituted | crossed at round 2 | 1 |

`docs/results/audit-attested.json`, `docs/results/audit-substituted.json`

### Sizing the reference measurement

`node scripts/export-attestation.mjs`

R(c,j) is estimated from a finite number of draws and carries its own sampling error. When that
error is comparable to the envelope width, the audit cannot separate a permitted configuration
from a departure, and a clean endpoint crosses on the noise in its own reference.

Issuance bounds that error by bootstrap and refuses when it exceeds 10% of the envelope width,
printing the sample size required. This is the same class of precondition as the calibration
granularity check `AttestationRegistry` enforces on chain: an attestation is sized before coverage
is written, never after a claim.

---

## The two implementations agree exactly

`make vectors` · `contracts/vectors/bsa1-vectors.json`

The TypeScript engine runs the whole verdict path and writes the exact integers. The Solidity
adjudicator reproduces every one of them.

| Quantity | Cases |
|---|---:|
| `ln` | 36 |
| `exp` | 29 |
| `pow` | 58 |
| empirical distribution | 48 |
| Jensen-Shannon divergence | 48 |
| rank p-value | 48 |
| calibrated e-value | 48 |
| minimum over M, mean over cells | 16 each |
| Ville boundary | 4 |

Equality is asserted exactly, not within a tolerance.

### BSA-1 error against a 60-digit reference

`packages/core/vectors/bsa1-reference.json`

| Function | Bound |
|---|---|
| `ln` | 1e-25 absolute |
| `exp` | 4e-27 absolute plus 1e-25 relative |
| `pow` | 1e-24 absolute |

---

## The precompile, checked live

`node scripts/check-p256.mjs` · `docs/results/p256-live.txt`

All nine WebAuthn fixtures sent to `0x0100` on Monad testnet. The precompile verified every one,
including the six replay vectors, because each carries a genuine secp256r1 signature. What rejects
a replay is the ceremony above the curve check.

---

## Onchain cost

`forge test --match-contract ProtocolTest -vv`

| Operation | Gas |
|---|---:|
| Settle 32 policies in one transaction | 3,215,433 (100,482 per policy) |
| Adjudicate one disputed cell e-value | 188,850 |
| Purchase, including the full WebAuthn ceremony | ~985,000 |

Monad allows 30,000,000 gas per transaction inside a 150,000,000 block.

---

## Tests

`make test`

| Suite | Tests |
|---|---:|
| `ProtocolTest` | 19 |
| `EvidenceTest` | 12 |
| `DifferentialTest` | 9 |
| `InvariantsTest` | 7 invariants, 128 runs × 8,192 calls each |
| `WebAuthnTest` | 6 |
| `@backstop/core` | 18 |

53 contract tests and 18 engine tests, all passing.
