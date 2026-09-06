# BACKSTOP on Chainlink CRE

The audit cadence is an orchestration problem, and CRE is the orchestration layer.

A round is not one call. It opens on a seed built from two independent shares, executes probes
against an external inference API, seals the transcript commitments, and only then reveals the
calibration slice and publishes the verdict. That ordering is what makes the p-value valid
conditional on everything an adaptive actor could have seen, rather than only on average over
the calibration draw. It has to happen in order, on a fixed cadence, unattended, with an
external HTTP call in the middle and three chain writes around it.

## What the workflow touches

| Leg | What it is |
|---|---|
| Blockchain | Monad. Reads `nextRound` from `AuditRegistry`, writes `openRound`, `sealRound`, `closeRound`. |
| External API | The inference endpoint under audit, over HTTP, with the sampling contract the attestation pinned. |
| Computation | The e-process engine from `@backstop/core`, run inside the workflow. |
| Randomness | A public beacon, supplying the second share of the round seed so a block producer is never in the assignment path. |

## Cadence and the seed

The attestation pins the round cadence and the beacon round the second share is drawn from, so
the seed for a round is fixed before the round opens and nobody chooses which beacon value gets
used. The issuer's share comes from a hash chain committed at issuance, held in CRE secrets and
released one per round. Neither party can steer the assignment alone.

## Run it

```bash
cre workflow simulate --target monad-testnet    # local simulation through the CRE CLI
cre workflow deploy   --target monad-testnet    # live deployment on the CRE network
```

Chainlink lists Monad mainnet from CLI v1.29.0 and Monad testnet from v1.30.0.

## Secrets

| Name | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | the probe-scoped credential, limited to the probe model with a spend cap |
| `seed-share-<t>` | the issuer's precommitted hash-chain share for round t |
