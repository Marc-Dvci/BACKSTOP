# BACKSTOP on Chainlink CRE

The audit cadence is an orchestration problem, and CRE is the orchestration layer.

A round is not one call. It opens on a seed built from two independent shares, it fixes the
audited responses, and only then does it reveal the calibration slice and publish the verdict.
That ordering is what makes the p-value valid conditional on everything an adaptive actor could
have seen, rather than only on average over the calibration draw. It has to happen in order, on a
fixed cadence, unattended, with external HTTP calls in the middle and three chain writes around
it.

## What the workflow touches

| Leg | What it is |
|---|---|
| Blockchain | Monad testnet. Reads `nextRound` from `AuditRegistry`; writes `openRound`, `sealRound` and `closeRound` as a signed CRE report. |
| External API | The drand beacon, supplying the second share of the round seed, and the evidence producer's published bundle for the round. |
| Computation | The e-process engine from `@backstop/core`, run inside the workflow. |

`@backstop/core` has no Node built-ins and no native code — `@noble/hashes`, `@noble/curves` and
`zod` are its whole dependency set — so the engine that settles onchain runs unmodified inside the
workflow's QuickJS sandbox. It is not reimplemented for CRE, which matters: two implementations of
the verdict path would be two things to keep in agreement, and the canonical arithmetic exists
precisely so there is one.

## Why the probes are not executed in the workflow

This is the design question a reader should ask, because the obvious workflow loops over the probe
battery and calls the inference endpoint from inside the handler.

That would be wrong. A DON runs a handler on every node, so the loop executes each scheduled probe
once per node and keeps the value the DON agrees on. That is exactly the retry selection the
evidence layer closes: a probe whose result can be drawn more than once and reconciled afterwards
reports a selection rather than a sample, and the p-value stops being valid. §6.3 makes one
execution per scheduled probe an onchain property, enforced by `TicketRegistry`.

So the probes stay with the ticketed evidence producer, which reserves onchain before it calls
upstream and publishes whatever comes back. The workflow consumes what the producer published and
the nodes agree on it by value. The DON decides that the evidence is the evidence, which is a
consensus question; it does not re-run the experiment, which would not be one.

The beacon is the mirror case, and it is fetched through the DON for the same reason. Every node
sees the same drand round, so identical-value consensus is exactly right, and putting it through
the DON is what stops the issuer choosing the beacon value that suits the producer assignment it
wants.

## The write path

A CRE workflow does not send a transaction. The DON agrees on a payload, signs it as a report, and
the Keystone forwarder delivers it to a receiver. `contracts/src/CREReceiver.sol` is that receiver:
it is registered as the version's issuer, which is the only address `AuditRegistry` accepts a
transition from, so the cadence reaches the chain carrying the DON's consensus rather than one
operator's word.

Three checks stand between a report and a round transition, and each closes a distinct way the
cadence could be written by someone who should not be writing it: the caller must be the
configured forwarder, the report must carry the workflow id and owner the receiver was built for,
and the payload must name the version the receiver serves. Ordering stays where it already lives:
`AuditRegistry` refuses a transition that arrives in the wrong state, so the receiver delegates to
it and there is one copy of that rule rather than two to keep in agreement.
`contracts/test/CREReceiver.t.sol` asserts all of it, including that a replayed transition reverts
with the registry's error rather than one of the receiver's.

## Cadence and the seed

The attestation pins the round cadence and the beacon round the second share is drawn from, so the
seed for a round is fixed before the round opens and nobody chooses which beacon value gets used.
The issuer's share comes from a hash chain committed at issuance, held in CRE secrets and released
one element per round. Neither party can steer the assignment alone.

## Run it

```bash
cd cre
cre login                                                       # a Chainlink CRE account
cre workflow simulate backstop-audit --target monad-testnet-settings
cre workflow deploy   backstop-audit --target monad-testnet-settings
```

Chainlink lists Monad mainnet from CLI v1.29.0 and Monad testnet from v1.30.0. The TypeScript SDK
carries a chain selector for both; `monad-testnet` is `2183018362218727504`, and the workflow reads
it out of the SDK's own table rather than pasting the constant.

## What CI checks

`backstop-audit/main.ts` type-checks against the published `@chainlink/cre-sdk@1.21.0` — the real
capability classes, the real `Runner`, the real report and secret shapes — and
`pnpm -r exec tsc --noEmit` covers it on every push, so the workflow tracks the SDK rather than a
remembered version of it. The chain selector is read from the SDK's own table, so a workflow
pointed at a chain CRE does not serve fails at startup rather than silently. The receiver is
exercised by 11 Foundry tests over the metadata layout the forwarder actually packs, covering the
whole round through the report path and every rejection the three checks above are there to make.

## Installing the SDK outside bun

`@chainlink/cre-sdk@1.21.0` declares `"@chainlink/cre-sdk-javy-plugin": "workspace:*"` in its own
manifest, which resolves only inside Chainlink's monorepo, so npm and pnpm both refuse it and the
documented toolchain is bun. The root `package.json` pins that plugin to its published `1.7.0`
through a `pnpm.overrides` entry, which is what lets this package install under the same pnpm
workspace as everything else and take part in the same typecheck.

## Secrets

| Name | Purpose |
|---|---|
| `seed-share-<t>` | the issuer's precommitted hash-chain share for round `t` |
