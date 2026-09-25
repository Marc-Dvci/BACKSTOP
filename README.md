<div align="center">

# BACKSTOP

**Capital-backed verification for hosted AI inference.**

Continuous statistical proof that an endpoint still serves what it claims,
computed under an arithmetic the chain reproduces, with a payout attached.

Monad Metropolis · Trust, Identity & AI Infrastructure

**[Live on Monad testnet](https://backstop-smoky.vercel.app)**

[Reliability index](https://backstop-smoky.vercel.app) · [Method](https://backstop-smoky.vercel.app/method) · [Docs](https://backstop-smoky.vercel.app/docs) · [Claim vault](https://backstop-smoky.vercel.app/vault)

</div>

---

## What it is

Buying inference is buying a claim. The label names a model, a precision and a context length.
What arrives is a sample from a distribution, and no single response tells the buyer whether they
received what they paid for.

BACKSTOP continuously tests whether an endpoint remains statistically consistent with the
behavioural envelope its attestation committed to, proves each test result from cryptographically
authenticated responses, and turns a proven departure into an executable guarantee.

Nothing black-box proves byte-identical weights. What a statistical test establishes is whether
behaviour still sits inside an envelope defined in advance to contain the serving variation a
provider is allowed and to exclude a change of model or declared precision. BACKSTOP fixes that
envelope, the probe battery, the calibration material and the lifetime error budget on chain
**before any round runs**, and then measures.

Once conformance is verifiable to that standard, the signal is strong enough to settle capital
against. The reference application is a market in which independent underwriters price the
guarantee, so the cost of covering an endpoint becomes a public statement about whether it can be
trusted.

> Black-box detection of model substitution is practical. Economic consequence is missing.
> BACKSTOP measures any OpenAI-compatible endpoint without permission, and pays out on the
> endpoints characterised well enough to underwrite.

---

## Measured results

Every number here is produced by the code in this repository. Each row names the script that
regenerates it.

### Caught on Monad testnet, from real completions

Two versions attest Qwen3-1.7B on Monad testnet with the same envelope. Each round, llama.cpp
serves the model, the round's committed probes go to it one request each, and the issuer opens,
seals and closes the round on chain: the seed from its hash chain and a drand quicknet value, the
transcript root before the verdict, then E(t).

| Version | The endpoint served | Rounds | log M | Result |
|---|---|---:|---:|---|
| [v5](https://backstop-smoky.vercel.app/endpoint/5) | Q8_0, a declared element of the envelope | 7 | −0.5818 | **consistent** |
| [v6](https://backstop-smoky.vercel.app/endpoint/6) | Q8_0 for rounds 0 to 2, **Q4_K_M from round 3** | 6 | 3.1231 | **crossed at round 5** |

On v6 the three Q8_0 rounds read E(t) = 0.60, 0.88 and 1.18. The three Q4_K_M rounds read 3.56,
3.75 and 2.74, and log M passed ln(1/α) = 2.9957, fixed before round 0, on the third. Three
policies written on v6 before its first round, 105,000 bUSDC of notional authorised by passkey
assertions through the P256 precompile, settled at that round in
[one transaction](https://testnet.monadexplorer.com/tx/0xa71f6ff2de31b210b4b7aa8a6e7d48ac68c72040f38900357949751869dc7542)
of 641,142 gas. The testnet deployment runs a 10-minute challenge window.

A round is 768 completions, 8 cells of 96, and took 97 seconds on a six-core desktop CPU. Every
round is published on the [`live-data`](https://github.com/Marc-Dvci/BACKSTOP/tree/live-data)
branch as a record and its transcripts, request and response byte for byte, and checks with
nothing but the repository:

```bash
make replay-live                                   # the v6 crossing, from its record alone
node scripts/live/verify-transcripts.mjs --version 6 --round 5
```

```
  ok    issuer seed share hashes forward to the committed chain root
  ok    round seed is the combination of both shares
  ok    cell selection derives from the seed
  ok    fingerprint partitions prove against the committed pool root
  ok    calibration slice proves against the committed pool root
  ok    published E(t) matches the recomputation      E(t) = 2.74293250

  ok    every commitment is the hash of its request and response bytes
  ok    their Merkle root is the transcript root sealed on Monad
  ok    normalising the responses reproduces every cell's counts
```

The reference pool, the seed chain and the probe corpus derive from issuer secrets. Only their
roots are on chain at issuance, and each round's share of them is published after that round
seals. Each record names the host that served it. `.github/workflows/live.yml` runs the same
round on a GitHub runner on a daily schedule.

### The envelope declares the stack the endpoint runs

The same Q8_0 weights on llama.cpp's CPU backend answer measurably differently from the GPU build
the reference was first measured on. So the stack was measured where it runs, 20,000 draws per
cell on GitHub's runners (`.github/workflows/measure-stack.yml`), and declared as its own element
of the envelope.

| Mean JSD over 8 cells | |
|---|---:|
| Q8_0 GPU against BF16 GPU, the permitted width | 0.002423 |
| Q8_0 CPU against Q8_0 GPU | 0.001043 |
| Q4_K_M against Q8_0 CPU, the substitution | 0.034965 |

### The lifetime Type-I bound

Ville's inequality gives `P(∃T ≤ T_max : M(T) ≥ 1/α) ≤ α`. The realised lifetime crossing rate is
the number the whole design is gated on, so it was measured first, before any financial contract
was written.

| Endpoint serves | Crossings | Realised | 95% CI | Nominal α |
|---|---:|---:|---|---:|
| a vertex of M | 0 / 4,000 | 0.0000 | [0.0000, 0.0010] | 0.05 |
| a mixture element of M | 0 / 4,000 | 0.0000 | [0.0000, 0.0010] | 0.05 |
| the second vertex of M | 0 / 4,000 | 0.0000 | [0.0000, 0.0010] | 0.05 |

12,000 trials across 40 independently generated reference pools, m = 99, n = 64, T_max = 40,
8 cells, |M| = 3. `make gate-zero`

### Benign versus substitution

| | Result |
|---|---|
| Benign configuration changes inside the envelope | **0 crossings in 1,600 trials** |
| Full substitution, α = 0.05 | 200 / 200, median delay 8 rounds |
| Dilution ε = 0.5 | 200 / 200, median delay 8 rounds |
| Dilution ε = 0.3 | 200 / 200, median delay 11 rounds |
| Dilution ε = 0.2 | 200 / 200, median delay 17 rounds |
| Dilution ε = 0.1 | 200 / 200 once the sample size is raised, see the table below |

Eight benign scenarios: each vertex held for a lifetime, each mixture held, switches mid-lifetime
in both directions, alternation every round, and per-cell rotation across the envelope.
`make bench`

### The detection floor is a sample-size dial

A probe costs one output token, so draws per cell are the cheapest lever the protocol has. The
floor moves with it and the false-alarm control holds at every sample size, so an attestation is
sized against the dilution its buyer wants covered before coverage is written.

| Dilution ε | Draws per cell | Queries per round | Power | Median delay | Benign crossings |
|---:|---:|---:|---:|---:|---:|
| 0.10 | 64 | 512 | 0.000 | — | 0 / 60 |
| 0.10 | 128 | 1,024 | 0.983 | 20 | 0 / 60 |
| 0.10 | 256 | 2,048 | **1.000** | 10 | 0 / 60 |
| 0.10 | 512 | 4,096 | **1.000** | 6 | 0 / 60 |
| 0.05 | 512 | 4,096 | **1.000** | 19 | 0 / 60 |

`make bench`

### Caught on a real endpoint, live

Qwen3-1.7B was served from `llama.cpp` and audited through the CLI against a committed
attestation. Nothing was simulated: real probes, real completions, the threshold fixed before the
first request.

| Endpoint served | Attestation | Result | Exit code |
|---|---|---|---|
| **BF16**, the attested precision | v1 | 6 rounds, log M decayed to −1.28, **consistent** | 0 |
| **Q4_K_M**, substituted | v1 | **crossed at round 2** | 1 |

Three rounds at 8 cells and 96 draws is **2,304 single-token queries** to catch a quantisation
swap. `backstop audit --attestation attestations/reference.json --pool pools/v1.json`

### Envelope width, on a real model

Qwen3-1.7B run locally at three quantisations through the probe battery, **20,000 draws per cell
per configuration**, 480,000 completions in 79 minutes on one RTX 4070. Q8_0 is a declared element
of the envelope; Q4_K_M is the substitution.

| | Mean JSD against BF16 |
|---|---:|
| Q8_0, declared envelope element | 0.002423 |
| Q4_K_M, substitution | 0.028402 |
| **Separation** | **11.72×** |

The substitution sits 11.72 times further from the attested precision than the permitted
configuration does, measured on the same cells with the same arithmetic. On `letter.en` the mode
of the answer distribution flips outright between BF16 and Q4_K_M. `make harness`

### Sizing an attestation before it can be sold

R(c,j) is estimated from a finite number of draws and carries its own sampling error. When that
error is comparable to the envelope width, the audit cannot separate a permitted configuration
from a departure and a conforming endpoint crosses on the noise in its own reference.

Issuance bounds that error by bootstrap and **refuses to issue** above 10% of the envelope
width, printing the sample size required:

```
  cell             reference noise    envelope width     ratio
  digit.en                0.000064          0.004058    0.015x
  letter.fr               0.000049          0.000708    0.069x
  mean                    0.000055          0.002423    0.023x
  measured with 20,000 draws per cell per configuration
  within the 10% budget, so the attestation may be issued
```

At 500 draws the same check reports `0.425x` and refuses, naming the sample size that would clear
it. This is the same class of precondition as the calibration granularity `AttestationRegistry`
enforces on chain: an attestation is sized before coverage is written, never after a claim.

### The sampling contract travels with the reference

The attestation pins every parameter the audit sends, down to provider-specific switches, and one
function builds every request body from it. The harness that measures the reference, the CLI that
audits, the evidence producer and the CRE workflow emit byte-identical bodies for the same probe,
and the CLI refuses to run when the contract hash does not match the one the reference was
measured under.

That is not a hygiene note. Qwen3 exposes a reasoning mode, and to a single-token battery the same
weights with thinking on and thinking off are two different endpoints.

### The two implementations agree exactly

The statistic takes logarithms and the calibrator raises a p-value to a fractional power, so
conforming floating-point implementations can disagree in the last bits. Near the boundary that is
the difference between a claim and no claim.

The differential suite runs the TypeScript engine over the whole verdict path, writes the exact
integers, and asserts the Solidity adjudicator reproduces every one of them: **36 logarithms, 29
exponentials, 58 powers, and 48 cases each of empirical distribution, divergence, rank p-value and
calibrated e-value**. Equality is asserted exactly, not within a tolerance. `make vectors`

### Onchain cost

| Operation | Gas |
|---|---:|
| Settle 32 policies in one transaction | 3,215,433 (100,482 per policy) |
| Adjudicate one disputed cell e-value | 188,850 |

Monad allows 30,000,000 gas per transaction inside a 150,000,000 block and charges `gas_limit`
rather than `gas_used`, so the batch path is explicitly bounded and the adjudicator recomputes a
full cell rather than accepting an assertion.

### The precompile, checked live

All nine WebAuthn fixtures were sent to `0x0100` on Monad testnet. The precompile verified every
one of them, including the six replay vectors, because each carries a genuine secp256r1
signature. What rejects a replay is the ceremony above the curve check: the digest it signed is
bound to a different chain, contract, policy version, nonce or notional, and `WebAuthnP256.verify`
compares the challenge in `clientDataJSON` against the digest actually being authorised. That
separation is the reason the ceremony exists. `node scripts/check-p256.mjs`

### Tests

64 contract tests pass, including 7 invariants over 128 runs × 8,192 calls each, 9 WebAuthn
ceremony fixtures with genuine secp256r1 signatures, 9 differential suites against the TypeScript
engine, and 11 over the CRE report path.

The audit itself is exercised on every push, against an endpoint the repository stands up itself,
on both the attested precision and the substitution. Both directions are asserted, because a
detector that fires on everything is as useless as one that fires on nothing. `make ci-audit`

---

## The demo, end to end

```
make demo
```

One command stands up a chain with Monad's P256 precompile at `0x0100`, deploys the six
contracts, issues four attestations, deposits underwriter capital, buys policies with real passkey
assertions, runs the audit with the real e-process engine over the measured Qwen3 laws, switches
the endpoint to a cheaper quantisation partway through, and settles the cohort in one transaction.

```
   round  0  E(t)     1.033  log M     0.033  ..........................   1%
   round  1  E(t)     0.655  log M    -0.388  .......................... -13%
   round  2  E(t)     1.011  log M    -0.377  .......................... -13%
   round  3  E(t)     0.945  log M    -0.433  .......................... -14%
   round  4  E(t)     0.684  log M    -0.812  .......................... -27%
   round  5  E(t)     0.749  log M    -1.101  .......................... -37%
   -- the endpoint switches to the cheaper quantisation --
   round  6  E(t)     3.209  log M     0.064  #.........................   2%
   round  7  E(t)     4.055  log M     1.464  #############.............  49%
   round  8  E(t)     3.178  log M     2.620  #######################...  87%
   round  9  E(t)     3.420  log M     3.850  ########################## 129%

   CROSSED at round 9. The evidence passed ln(1/alpha) = 2.9957, fixed before round 0.

   control endpoint  log M -2.8424  flat
   benign change     log M -2.4111  flat

   settled 4 policies in one transaction, 684,463 gas (171,115 per policy)
   paid out 493,729 bUSDC
```

Four rounds from the switch to the payout, at 768 single-token queries per round. The control
endpoint and the benign configuration change stay flat on the same axes.

---

## How it works

### Two tiers

**Measurement.** Ordinary probes against public endpoints, run by anyone, published with their
hashes. Produces the public reliability index. Needs no permission and no counterparty.

**Settlement.** Only responses carrying a transcript attestation enter the process that can open a
window, and only for endpoints that are fully characterised.

> An attestation may back a policy only if none of its settlement-critical fields is tagged
> `unknown`. Those fields are model identity, serving stack, and the mixture set `M`.

The null protects exactly the configurations enumerated in `M`, so an endpoint whose routing
cannot be enumerated is excluded by construction rather than by caution. The predicate is enforced
at issuance in `AttestationRegistry`, not at the point of sale.

### The verdict path

| # | Step | Produces | Why it holds |
|---|---|---|---|
| 1 | Rank p-value against the calibration slice | `p = (1 + #{i : S0_i ≥ S}) / (m + 1)` | `R(c,j)` comes from a disjoint partition, so the m + 1 statistics are i.i.d. and the rank is exactly super-uniform. The slice is unrevealed until the round seals, so this holds conditional on the filtration rather than only marginally. |
| 2 | Calibrate p to e | `e = λ · p^(λ−1)` | Integrates to 1 over the unit interval, so `E[e] ≤ 1` under any super-uniform p. |
| 3 | Minimum across the mixture set | `e(t,j) = min over c in M` | Bounded above by the e-value of the true element, so validity is uniform over the composite null. |
| 4 | Combine cells | `E(t) = (1/k) · Σ e(t,j)` | The arithmetic mean of e-values is valid under arbitrary dependence, and cells in one round are dependent. |
| 5 | Combine rounds | `M(T) = Π E(t)` | A nonnegative test supermartingale. Ville covers the whole lifetime rather than one look. |

### Why a policy costs two storage reads

`M_version` is the product of every round since the version was issued. A policy's own process is

```
log M_π(T) = cumLog(T) − cumLog(startRound − 1)
```

The `AuditRegistry` stores `cumLog` per round, so a policy written at any inception date is
settled from two storage reads rather than from a loop over its history. Evidence from before a
policy existed is arithmetically incapable of reaching its boundary, which makes the inception
cut-off a property of the arithmetic rather than a rule someone has to enforce. `M_version` never
pays anything.

### The evidence layer

Authentic bytes are not an unbiased sample. Three biases are closed by ordering rather than by
asking anyone to behave:

| Bias | What closes it |
|---|---|
| Omission | Scheduled probes are committed at issuance; a missing execution is a void, not an absence |
| Retry selection | Reservation is onchain, precedes the upstream request, names one producer, and a tuple never returns to `AVAILABLE` |
| Inclusion selection | The producer publishes, not the claimant, and it publishes before the contributor sees the content |

A voided execution contributes the minimum e-value the calibrator can emit, `e = λ` at `p = 1`.
That is the most null-favourable outcome available, so suppression is strictly worse for a
claimant than submitting, and since `λ < 1` the supermartingale survives.

The mirror attack, a producer aligned with the endpoint reserving tickets and never publishing, is
bounded by producer bonds, by deterministic assignment from a seed built as
`keccak256(issuerShare ‖ beaconValue)`, by k-of-n redundancy over distinct probes, and by a
void-rate circuit breaker that suspends the version.

### Settlement

Optimistic, with onchain adjudication of one named quantity. A challenger bonds and names a
specific `(round, cell, mixture element)` triple; the contract recomputes exactly that quantity
under BSA-1 from the committed material and compares. The loser's bond goes to the winner.

Redemption never trusts the claim root. Each redemption re-derives the crossing from the
cumulative logs, so a root that over-includes pays nobody it should not and a root that
under-includes costs a claimant one extra call.

### The canonical arithmetic

```
BSA-1|scale=1e27|round=trunc-toward-zero|ln=atanh-10-tab16|exp=taylor-25
```

Signed integers at scale 1e27, truncation toward zero throughout, no arithmetic shift ever applied
to a negative value, and one named algorithm for each transcendental. The spec string is hashed
into every attestation and asserted by the Solidity library, so a change on either side breaks the
attestation reference rather than changing a verdict underneath a live policy.

Measured against a 60-digit reference table: **ln within 1e-25 absolute, exp within 4e-27 absolute
plus 1e-25 relative, pow within 1e-24 absolute.**

---

## Why Monad

1. **P256 precompile at `0x0100`.** The precompile verifies an ECDSA signature and nothing more,
   so `WebAuthnP256.sol` implements the full ceremony on top: the signature covers
   `authenticatorData ‖ SHA256(clientDataJSON)`, the client data must declare `webauthn.get` and
   the registered origin, the challenge must equal the base64url of a domain-bound policy digest
   committing chain id, verifying contract, attestation version, policy version, nonce and expiry,
   the authenticator must report user presence and user verification, the credential must be the
   one enrolled, and `s` must be in the lower half of the curve order. Nine replay vectors are
   exercised against genuine signatures.
2. **Per-block premium accrual and per-audit requoting.** 400ms blocks make a per-second premium
   and a quote that moves on every round behave like a live market rather than a batch job.
3. **Settlement throughput with named limits.** 30M gas per transaction inside a 150M block,
   charging `gas_limit` rather than `gas_used`. Hence pull settlement plus a bounded batch push,
   and a measured policies-per-transaction figure rather than a discovered one. It is also what
   makes full onchain adjudication of a cell affordable at 188,850 gas.
4. **ERC-8004 as a first-class agent registry.** Issuers, the auditor and bonded providers
   register, so envelope quality and retirement behaviour accrue to an agentId a buyer can read.

---

## Deployed

Monad testnet, chain 10143.

| | |
|---|---|
| `AttestationRegistry` | [`0x7219…71e8`](https://testnet.monadexplorer.com/address/0x72193621705c660ffca7a8AFd3338EccB31571e8) |
| `AuditRegistry` | [`0xcacF…872F`](https://testnet.monadexplorer.com/address/0xcacFf7F418F92C160f270f6B4Db3B00fD739872F) |
| `CoveragePool` | [`0xA295…BA4e`](https://testnet.monadexplorer.com/address/0xA29548deCABE4c5A07461D00B7ED26dfFb10BA4e) |
| `PolicyRegistry` | [`0x8d6e…3902`](https://testnet.monadexplorer.com/address/0x8d6e370b95A783B983e40468413227ad94b03902) |
| `Settlement` | [`0x9d34…082B`](https://testnet.monadexplorer.com/address/0x9d344c625D7D62FA43ebc97528213B666893082B) |
| `TicketRegistry` | [`0xa91E…41C3`](https://testnet.monadexplorer.com/address/0xa91Ee747C648c8a6f9418FaB1C21b7f00DC441C3) |
| Settlement asset | [`0x29B3…4b50`](https://testnet.monadexplorer.com/address/0x29B33CB36D32Adf164784BdFdA40d034DD234b50) |
| ERC-8004 auditor | **agentId 1824** in the [Identity Registry](https://testnet.monadexplorer.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e), agentWallet `0x6a7a…870b` |
| ERC-8004 provider | **agentId 1927**, the endpoint the live cadence audits, [card](https://backstop-smoky.vercel.app/providers/backstop-reference.json) |
| Live versions | v5 and v6, attestations in [`attestations/`](attestations) |

The settlement asset is freely mintable on testnet, so a judge can fund a wallet and drive the
whole flow without asking anyone for tokens.

---

## Repository

```
packages/core         BSA-1 arithmetic, the verdict path, the probe battery, replay, simulation
packages/sdk          BackstopClient, the quote function, browser passkeys, the PRF claim vault
packages/cli          backstop audit, backstop replay, backstop index, backstop quote
packages/producer     the evidence producer: reserve, execute, publish
contracts             the six contracts plus the CRE receiver, BSA-1, Verdict, WebAuthnP256, 64 tests
apps/web              the live index, endpoint pages, the buy flow, the method pages, the vault
indexer               Envio HyperIndex, self-hosted: derived entities, not an event mirror
cre                   the audit cadence as a Chainlink Runtime Environment workflow
bench                 the envelope harness over a real open-weight model, and its analysis
scripts               the demo, the reference endpoint, the round exporter, the CI audit
action                the GitHub Action that fails a build on a departed endpoint
docs/results          every measured number, as JSON and as the raw run output
```

### Five minutes from clone to a verdict

```bash
git clone https://github.com/Marc-Dvci/BACKSTOP && cd BACKSTOP
make install
make build
make demo          # the whole protocol, end to end
make test          # 64 contract tests, the invariants, the differential suite
make ci-audit      # the CLI against a local endpoint, attested and substituted
make gate-zero     # the lifetime Type-I bound
make harness       # measure a real model across three quantisations
make replay        # recompute a verdict published on testnet, from its record alone
make indexer       # the self-hosted index over the testnet deployment, GraphQL on :8080
```

### Recompute a published verdict yourself

`make replay-live` downloads a round the live cadence published and recomputes it with the CLI
from the record alone, with no pool file, no key and no chain access. `make replay` exports the round that crossed on Monad testnet and then recomputes it. The
exporter refuses to write unless the E(t) it recomputes equals the one the AuditRegistry holds,
so the record it produces is the round the issuer actually closed, not a reconstruction of one.
The CLI then checks it end to end:

```
BACKSTOP replay  round 8

  ok    issuer seed share hashes forward to the committed chain root
  ok    round seed is the combination of both shares
  ok    cell selection derives from the seed
  ok    fingerprint partitions prove against the committed pool root
  ok    calibration slice proves against the committed pool root
  ok    published E(t) matches the recomputation

  recomputed E(t) = 3.60190197
  published  E(t) = 3.60190197
```

The record carries 24 fingerprint partitions and 2,376 calibration blocks, each with a Merkle
proof against the pool root fixed at issuance. Change one count in one block and the calibration
check fails and names the block.

### Catch a substitution in one minute, with no GPU and no API key

The audit needs an endpoint, and until now that meant a local llama.cpp with several gigabytes of
weights or a funded key on a public router. The reference endpoint removes both. It serves the
probe battery from the laws the harness measured off Qwen3-1.7B, so the CLI reaches a verdict
against the same behaviour that produced the numbers above.

```bash
make build
node scripts/reference-endpoint.mjs --serve bf16 &      # the attested precision
backstop audit --attestation attestations/reference.json --pool pools/v1.json                --base-url http://127.0.0.1:8080/v1 --model local --rounds 6
```

```
  round  0  E(t)     0.7292  log M    -0.3158  ................................ -10.5%
  round  5  E(t)     0.6440  log M    -1.1839  ................................ -39.5%

  CONSISTENT with the attested envelope after 6 round(s).                        exit 0
```

Restart it with `--serve q4km` and nothing else changes:

```
  round  0  E(t)     3.8117  log M     1.3380  ##############.................. 44.7%
  round  1  E(t)     3.6072  log M     2.6210  ############################.... 87.5%
  round  2  E(t)     4.0189  log M     4.0120  ################################ 133.9%

  CROSSED at round 2. The evidence passed the boundary fixed before the audit began.  exit 1
```

Round 2 is where the live llama.cpp run crossed as well. Nothing about the verdict path is
mocked: the requests carry the sampling contract the attestation pinned, the responses go through
the same normalization, and the engine is the one that settles onchain. What the endpoint replaces
is the model, by sampling from the categorical law per cell that the battery reduces every
response to anyway.

It is also deterministic. Each cell's draw stream is fixed by `--seed`, so `make ci-audit` asserts
both verdicts on every push and a red build means the verdict path changed rather than that the
dice came up differently.

Demonstrating a substitution at all requires an endpoint nobody else owns. Pointing it at a named
commercial provider would be an accusation; pointing it here is a measurement.

### Audit any OpenAI-compatible endpoint

```bash
pnpm --filter @backstop/cli build && npm link packages/cli

backstop audit \
  --attestation attestations/reference.json \
  --pool pools/v1.json \
  --base-url https://openrouter.ai/api/v1 \
  --model meta-llama/llama-3.3-70b-instruct \
  --api-key-env OPENROUTER_API_KEY \
  --rounds 4

# exit 0  consistent with the attested envelope
# exit 1  the evidence crossed the precommitted boundary
# exit 2  the run could not complete
```

The transport is any OpenAI-compatible endpoint. The envelope is not: an attestation names the
configuration mixture it was measured against, so pointing the committed reference pool at a
different model measures the gap between two models rather than the endpoint's conformance.
`attestations/reference.json` covers qwen3-1.7b at the precisions in `bench/out/laws.json`.
Issuing one for another endpoint means measuring its declared configuration first:

```bash
make harness                              # measure the declared configurations
node scripts/export-attestation.mjs       # commit the pool and issue the attestation
```

### Ten lines to coverage

```ts
import { BackstopClient, deployment, assert } from "@backstop/sdk";

const backstop = new BackstopClient({ deployment, account });

const status = await backstop.endpointStatus(1n);
const quote  = backstop.price({ notional: 25_000_000000n, termSeconds: 30 * 86400, ...curve });

const digest    = await backstop.policyDigest(terms);
const assertion = await assert({ rpId: deployment.rpId, challenge: digest });

await backstop.purchase({ terms, assertion, credentialId, quoteInputs });
await backstop.redeem(policyId, crossingRound);
```

---

## Who this is for

**Why a team uses this rather than writing its own check.** Four parts take the time: a test that
stays valid when an endpoint moves between permitted configurations, a reference measured on
weights the auditor holds, a calibration pool whose slices are revealed only after each round, and
a verdict a third party can recompute. The CLI brings all four to one command, and the Action
brings it to a pull request.

**Research and evaluation teams.** Results are invalidated when the served model changes
underneath them. Serving backends shift benchmark scores by up to 16.6 percentage points, and a
NeurIPS 2025 paper on reasoning-model illegibility had its findings overturned when different
OpenRouter providers were used at identical quantisation. On
`meta-llama/llama-3.3-70b-instruct` the most expensive endpoint is fp8, a cheaper one is bf16, and
the cheapest is fp8 again, so price carries no information about precision. The current workaround
is manual pinning plus hope. They run open-weight models through third-party providers, which is
the settlement tier's launch scope, and they publish, so they are a distribution channel.

**Regulated deployers.** *Quality Is Not a Safety Proxy Under Quantization* reports refusal rates
falling 12 to 68 percentage points on checkpoints whose quality metrics held stable or improved,
in 7 of 11 AWQ/GPTQ checkpoints. An operator documenting a deployed system under the EU AI Act
against one set of weights, and served another, has documentation that no longer describes the
system. No quality gate detects it.

**Agent operators buying through routers.** Silent degradation they cannot diagnose from their own
logs. OpenRouter built Exacto to route around provider variance and states that it is
"specifically focused on tool-calling, and should not be viewed as a broader statement on endpoint
or provider quality." The largest router measured the problem, shipped machinery for one slice,
and left the rest of the served artefact unguaranteed.

**Underwriters.** A live signal nobody else has, a quote function showing how it was derived, and
a new measurable risk factor.

**Providers who want a bond.** Not incumbents. Small gateways, resellers and agent platforms
competing on trust with no way to prove it. A posted bond is the one claim a larger competitor
cannot match without accepting the same liability.

Most inference terms of service reserve the right to change serving configuration, so a provider
swapping precision is usually inside its own contract and there is no pre-existing duty to
enforce. Hence a voluntary commitment on the supply side and a purchased hedge on the demand side.

---

## Prior art

**Escrow.** x402r, the Commerce Payments Protocol and the Agentic Settlement Protocol escrow one
transaction and release on a per-transaction verdict. Substitution is not a per-transaction
failure: any single response is plausible under both the advertised model and the substitute, so
the failure is visible only statistically, across a window, per endpoint. Escrow has no object to
attach that verdict to.

**Cryptoeconomic slashing.** EigenLayer AVSs, Chainlink node SLAs and DePIN inference networks
slash operators inside their own network, so the guarantee requires buying from that network. The
traffic, the money and the substitution are in the ordinary commercial market.

**Attested gateways.** *Evidence-Bound Gateway-Path Provenance for Third-Party LLM Inference* puts
an Attested Gateway Runtime in Nitro Enclaves and signs evidence binding policy, route, endpoint
identity and stream commitments. It makes the gateway prove what it did, requires every gateway to
adopt an attested runtime, and carries no consequence when one declines. BACKSTOP asks nothing of
the gateway and attaches money to the measurement.

**Transcript proofs.** zkAgent and TLSNotary-derived notarisation are the evidence primitive
BACKSTOP consumes.

BACKSTOP is statistical behavioural verification, anytime validity, authenticated API responses
and financial consequence in one stack.

---

## Sponsor integrations

| | How it is used |
|---|---|
| **Monad** | P256 precompile for the WebAuthn ceremony, 30M-gas transactions for onchain adjudication and batch settlement. ERC-8004: the auditor (agentId 1824) declares the cadence's issuer as its `agentWallet`, and after every live round that wallet writes −log M to the Reputation Registry against the provider's agent (1927), with the record's URI and keccak256 hash. 13 entries so far |
| **Chainlink CRE** | The audit cadence as a workflow: Monad reads and writes, the drand beacon, the evidence producer's published bundle, and the e-process engine running unmodified inside the QuickJS sandbox, in the order the statistics require. The three round transitions arrive onchain as a signed report through `CREReceiver`, which is the version's issuer. It type-checks against `@chainlink/cre-sdk@1.21.0` on every push, and `CREReceiver` carries 11 Foundry tests over the metadata layout the forwarder packs. `cre/` |
| **Envio** | HyperIndex over all six contracts, self-hosted with no account: `cd indexer && docker compose up` backfills from the deployment block and serves GraphQL on :8080. Derived entities: distance to boundary, realised detection delay, void rate against the declared breaker, collateralisation, loss ratio. The backfill reads through `indexer/rpc-cache.mjs`, which scans the contracts' logs once and serves eth_getLogs over any range, so 5.2 million blocks index in under 15 seconds. `.github/workflows/index.yml` runs the stack after each cadence and publishes the query's result, which [/protocol](https://backstop-smoky.vercel.app/protocol) reads when no live GraphQL endpoint answers. `config.hypersync.yaml` switches it to HyperSync |
| **Dynamic** | The signer for every transaction the product sends, not a login button beside one. `useWallet()` resolves to a Dynamic wallet, so a buyer who signed in with an email pays the premium and receives the payout from an embedded wallet that injects nothing into the page. An external wallet takes the same path. `apps/web/components/Providers.tsx`, `DynamicWallet.tsx`, `wallet.tsx` |
| **Mera** | One passkey, three namespaces, none of them a wallet: an encrypted claim vault recoverable on any device with nothing stored, a deterministic per-policy blinding factor for reproducible commitments, and a transcript-sealing key for evidence producers. `packages/sdk/src/prf.ts`, [live](https://backstop-smoky.vercel.app/vault) |

---

## Regulatory posture

The vocabulary is deliberate. A contract paying a pre-agreed sum on a measured trigger, with no
proof of loss and no insurable interest, resembles a derivative or event contract more than
indemnity insurance. In the EU that points at MiFID II rather than IDD and Solvency II, and MiCA
does not cover derivatives. In the US it points at CFTC event-contract treatment rather than state
insurance codes. A permissionless underwriting side is where the licensing question concentrates
under either framing.

Testnet only, no real premium, no solicitation of underwriters, aiming at a bilateral parametric
contract between informed counterparties. Mainnet would require a licensed vehicle on the
risk-bearing side or restricting the underwriting side to qualified participants. The measurement
tier has no regulated character and ships regardless.

---

## Licences and credits

`ToseaAI/llm-fingerprint-detector` is MIT and is the base for the probe battery, credited and
pinned by commit. `Photen/IRIS-audit` is PolyForm Noncommercial 1.0.0 for code and CC BY-NC 4.0 for
data; **no IRIS code or data enters this repository**, and IRIS-described methods are reimplemented
from the paper text and cited. See `NOTICE`.

Built solo for Monad Metropolis by [Marc Donovici](https://github.com/Marc-Dvci). I audit
information systems, payment systems and AI governance at Crédit Mutuel Alliance Fédérale's
Inspection Générale, and I lead AI for the Internal Audit function. One of my missions covered the
group's own AI architecture. The control I would write for inference bought from a third party is
the one this repository implements: a supplier attestation, independent testing against it, and
capital behind the result.
