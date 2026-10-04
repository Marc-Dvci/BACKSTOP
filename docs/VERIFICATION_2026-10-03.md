# Recorded verification — 4 October 2026

Verification of the current source, the recorded Monad campaign and the developer workflow.

| Check | Result | Verified scope |
|---|---|---|
| Workspace build | Passed | Core, SDK, CLI and producer |
| Core regressions | 45 passed | Integer arithmetic, WebAuthn, replay, statistical gate and genuine quicknet beacon signatures |
| SDK regressions | 16 passed | Credential identifiers, PRF encryption/export and quote calculations |
| CLI regressions | 4 passed | Committed sample size, campaign lifetime, sampling configuration and seed binding |
| Indexer regressions | 6 passed | Calldata, aggregates, ticket joins, duplicate events and warning transitions |
| Wallet regressions | 5 passed | Correct network, switch, cancellation and unknown-network handling |
| CRE scenario harness | 12 passed | Interrupted rounds, delayed producer, publication ordering, sealed roots, proof tampering, cumulative logs and report failures |
| Complete contract suite | 83 passed | Protocol lifecycle, security, P256, evidence, differential arithmetic, CRE receiver, issuer bonds, valid issuance sizes and stateful invariants |
| Stateful invariants | Passed | 128 runs and 8,192 calls; reserves, shares, exposure, redemption and asset accounting |
| Type checking | Passed | Workspace, web, SDK and CRE; generated Envio types checked separately |
| Production web build | Passed | Next.js production compilation and type validation |
| Actual-model campaign | 13 rounds passed | 9,984 transcripts, BLS beacon signatures, opened seeds, reveal roots, reference proofs, normalised counts and cumulative logs |
| Recorded policies | 3 passed | Version 6 policies 5–7; settled status and 105,000 test bUSDC total |
| Standalone package | Passed | Tarball installed outside the monorepo; actual-round replay and quote executed |
| GitHub Action Bash harness | 14 passed | Exit policies, report schema, stale/missing artifacts, verdict consistency and literal untrusted inputs |
| Reference audit fixture | Passed | Control: 4,608 queries across 6 rounds; substitution: crossing at round 2 after 2,304 queries |
| Known-null simulation | Passed | 200 trials per configuration across 4 pools; zero crossings in all 3 groups; 95% interval upper bound 0.0188 |
| Generated artifacts | Matched | Canonical arithmetic vectors and attestation schema regenerated in a Windows path containing spaces |
| Local protocol demonstration | Passed | Fresh Anvil contracts; measured-law samples, software-signed assertions and local P256 verifier fixture; four policies settled |
| Envio backfill | Passed | Recorded public log cache indexed through block 67,879,603 in Docker/Postgres/Hasura |
| GraphQL read | Passed | Public role reads the derived campaign metrics |
| Envio totals | Consistent | 31 rounds, 23,808 scheduled executions, 7 settled policies, 590,000 test bUSDC; seeded and actual activity |
| Responsive browser check | 22 passed | Main routes and 404 at 1440px and 390px; expected HTTP responses and layout containment |
| Concurrent RPC fallback | Passed | Six simultaneous real-data pages with controlled primary rate-limit failures |

The JavaScript suites contain **88 passing regression cases**. Contract tests include seven stateful invariants. Browser checks and Action scenarios are counted separately.

## Reproduce

```bash
pnpm build
pnpm test
pnpm test:indexer
pnpm test:web
pnpm test:cre
pnpm typecheck
pnpm --filter @backstop/web build
forge test --root contracts -vv
node scripts/verify-live-evidence.mjs
node scripts/pack-cli.mjs
```

## Evidence artifacts

- [Full actual-model campaign](results/evidence-audit-2026-10-03.json)
- [Envio GraphQL result](results/indexer-backfill-2026-10-03.json)
- [Action scenarios](results/action-audit-2026-10-03.json)
- [Responsive browser results](results/browser-audit-2026-10-03.json)
- [Concurrent RPC fallback](results/rpc-fallback-2026-10-03.json)
- [Local protocol demonstration](results/demo-2026-10-03.json)

The September deployment and evidence addresses identify the recorded experiment. The current source contains the verified lifecycle and security improvements. The index snapshot carries its historical watermark and capture timestamp.
