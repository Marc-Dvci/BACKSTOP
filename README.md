<div align="center">

# BACKSTOP

**Capital-backed verification for hosted AI inference.**

Continuous statistical proof that an endpoint still serves what it claims,
computed under an arithmetic the chain reproduces, with a payout attached.

Monad Metropolis · Trust, Identity & AI Infrastructure

[Live product](https://backstop.audit) · [Method](https://backstop.audit/method) · [Docs](https://backstop.audit/docs) · [Claim vault](https://backstop.audit/vault)

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
> BACKSTOP measures every public endpoint without permission, and pays out on the endpoints
> characterised well enough to underwrite.

---

## Measured results

Every number here is produced by the code in this repository. Each row names the script that
regenerates it.

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

### Envelope width, on a real model

Qwen3-1.7B was run locally at three quantisations through the probe battery, 500 draws per cell
per configuration, 12,000 completions in 2.6 minutes on one RTX 4070. Q8_0 is a declared element
of the envelope; Q4_K_M is the substitution.

| | Mean JSD against BF16 |
|---|---:|
| Q8_0, declared envelope element | 0.005350 |
| Q4_K_M, substitution | 0.026045 |
| **Separation** | **4.87×** |

The substitution sits 4.87 times further from the attested precision than the permitted
configuration does, measured on the same cells with the same arithmetic. On `letter.en` the mode
of the answer distribution flips outright between BF16 and Q4_K_M. `make harness`

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

### Tests

53 contract tests pass, including 7 invariants over 128 runs × 8,192 calls each, 9 WebAuthn
ceremony fixtures with genuine secp256r1 signatures, and 9 differential suites against the
TypeScript engine.

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

## Repository

```
packages/core         BSA-1 arithmetic, the verdict path, the probe battery, replay, simulation
packages/sdk          BackstopClient, the quote function, browser passkeys, the PRF claim vault
packages/cli          backstop audit, backstop replay, backstop index, backstop quote
packages/producer     the evidence producer: reserve, execute, publish
contracts             the six contracts, BSA-1, Verdict, WebAuthnP256, and 53 tests
apps/web              the live index, endpoint pages, the buy flow, the method pages, the vault
indexer               Envio HyperIndex: derived entities, not an event mirror
cre                   the audit cadence as a Chainlink Runtime Environment workflow
bench                 the envelope harness over a real open-weight model, and its analysis
action                the GitHub Action that fails a build on a departed endpoint
docs/results          every measured number, as JSON and as the raw run output
```

### Five minutes from clone to a verdict

```bash
git clone https://github.com/Marc-Dvci/backstop && cd backstop
make install
make build
make demo          # the whole protocol, end to end
make test          # 53 contract tests, the invariants, the differential suite
make gate-zero     # the lifetime Type-I bound
make harness       # measure a real model across three quantisations
```

### Audit any OpenAI-compatible endpoint

```bash
npm i -g @backstop/cli

backstop audit \
  --attestation attestations/openrouter-llama-3.3-70b.json \
  --pool pools/v1.json \
  --base-url https://openrouter.ai/api/v1 \
  --model meta-llama/llama-3.3-70b-instruct \
  --api-key-env OPENROUTER_API_KEY \
  --rounds 4

# exit 0  consistent with the attested envelope
# exit 1  the evidence crossed the precommitted boundary
# exit 2  the run could not complete
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
| **Monad** | P256 precompile for the WebAuthn ceremony, 30M-gas transactions for onchain adjudication and batch settlement, ERC-8004 for issuer and auditor reputation |
| **Chainlink CRE** | The audit cadence as a workflow: a chain, an external inference API, a randomness beacon and the e-process engine, in the order the statistics require. `cre/` |
| **Envio** | HyperIndex over every contract, with derived entities rather than an event mirror: distance to boundary, realised detection delay, void rate, collateralisation, loss ratio. `indexer/` |
| **Dynamic** | Embedded wallets so a buyer reaches coverage without a seed phrase, a server wallet for the unattended audit cadence, and an agent wallet with delegated evidence submission and claim redemption. `apps/web/components/Providers.tsx` |
| **Mera** | One passkey, three namespaces, none of them a wallet: an encrypted claim vault recoverable on any device with nothing stored, a deterministic per-policy blinding factor for reproducible commitments, and a transcript-sealing key for evidence producers. `packages/sdk/src/prf.ts`, [live](https://backstop.audit/vault) |

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

Built solo for Monad Metropolis by [Marc Donovici](https://github.com/Marc-Dvci).
