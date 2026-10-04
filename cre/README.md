# BACKSTOP on Chainlink CRE

The CRE workflow advances a BACKSTOP audit through open, seal and close. Monad state is its durable checkpoint: each invocation performs one transition and the next invocation resumes from the recorded state.

## Implemented flow

1. Read the version's statistics and commitments from its registry and compare the workflow configuration.
2. Derive the exact quicknet beacon round from `firstBeaconRound`, the audit round and the fixed cadence. Verify its BLS signature with the pinned network key and check SHA-256 randomness.
3. Verify the issuer's precommitted hash-chain share, then submit an OPEN report.
4. Poll for the producer's commitment bundle. Check the version, seed, selected cells, complete sample and unique transcripts; submit their Merkle root in a SEAL report.
5. After sealing, fetch the revealed reference slice. Check it against the issuance pool with the canonical replay engine, verify the sealed transcript root and cumulative log, then submit CLOSE.

The minute trigger polls outstanding producer stages. Opening cadence comes from the fixed beacon schedule. A pending HTTP 404 leaves the round in its current state for the next trigger. Each write checks transaction and receiver execution success.

## Producer API

`evidenceBaseUrl` serves two stages for each version and round:

| Path | Contents | Publication point |
|---|---|---|
| `/v<id>/round-<t>.transcripts.json` | Version/digest, round, seed shares, selected indices, observations and transcript commitments | After all scheduled executions |
| `/v<id>/round-<t>.json` | Complete `RoundRecord`, including proven reference slices and verdict | After the transcript seal |

The pre-seal bundle contains commitment and observation fields. The workflow enforces reference publication after sealing and computes from the revealed slice for that round.

Inference runs in the external producer. DON nodes agree on the published bundle rather than drawing and selecting separate model responses.

## Report receiver

`contracts/src/CREReceiver.sol` accepts the configured forwarder, workflow id and workflow owner. It binds each payload to its configured version and delegates ordering to `AuditRegistry`. The receiver is registered as that version's issuer.

The configuration supplies the receiver address and producer URL through `BACKSTOP_CRE_RECEIVER` and `BACKSTOP_EVIDENCE_BASE_URL`. Bind its version, statistics, digest, reference root and seed-chain root to the version issued for that receiver. Choose `firstBeaconRound` at campaign inception and retain it across retries.

```bash
pnpm build
pnpm test:cre
pnpm --filter backstop-cre typecheck
forge test --root contracts --match-contract CREReceiverTest -vv

cd cre
cre login
cre workflow simulate backstop-audit --target monad-testnet-settings
```

The scenario harness checks interrupted runs, producer delays, publication ordering, unique executions, changed roots, forged reference slices, cumulative logs, lifetime caps and receiver failures. Contract tests exercise the report metadata and each receiver guard.

The pnpm workspace pins `@chainlink/cre-sdk@1.21.0` and its published Javy plugin. Chain selectors come from the SDK table. Secrets use `seed-share-<t>` for each precommitted issuer share.

[Chainlink EVM client reference](https://docs.chain.link/cre/reference/sdk/evm-client-ts) ·
[drand protocol](https://docs.drand.love/docs/specification/) ·
[Official beacon verification](https://github.com/drand/drand-client/blob/master/lib/beacon-verification.ts)
