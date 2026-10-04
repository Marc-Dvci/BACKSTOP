# Verified release candidate: 4 October 2026

The local production candidate, its developer tools and the recorded September Monad
experiment were checked independently. These results refer to the revised source; publication
and a fresh contract deployment are separate actions.

| Check | Result | Scope |
|---|---|---|
| Workspace build and types | Passed | Core, SDK, CLI, producer, web and CRE |
| Production web build | Passed | Next 15.5.25 compilation, types and static output |
| Core | 54 passed | Arithmetic, serialization, sequential evidence, replay, WebAuthn and BLS beacons |
| SDK | 16 passed | Quotes, credential identifiers and PRF state |
| CLI | 8 passed | Configuration guards, state restoration, identity and saved verdicts |
| Producer | 6 passed | Committed probes/sampling, raw response checkpoints, receipt failure and unsafe retry prevention |
| Indexer | 11 passed | Committed boundary/schedule metadata, unavailable denominators, ticket joins and aggregate transitions |
| Web | 10 passed | Wallet network handling and actual browser evidence/control/tampering/anchor consistency |
| CRE scenario harness | 12 passed | Resumable transitions, publication ordering, roots, delayed producers and report errors |
| Solidity | 88 passed | Protocol, ownership, one-shot tickets, WebAuthn, disputes, issuer bonds and arithmetic parity |
| Stateful accounting | Passed | Seven invariants across 128 runs and 8,192 calls |
| Desktop and mobile routes | 24 passed | Twelve routes at 1440px and 390px, including `/verify`, purchase and expected 404; no page errors or overflow |
| Browser interaction | Passed | Actual control/crossing, ten local checks, rejected edited copy, downloads, independent direct Monad anchor and unavailable evidence |
| Restart integration | Passed | Four rounds equal two plus two exactly; an interrupted slice is conservatively consumed and never reused |
| Reference endpoint integration | Passed | Measured-law control: six rounds/4,608 requests; substituted configuration crosses at round 2 after 2,304 requests |
| Standalone CLI artifact | Passed | Tarball installed in an isolated directory; actual crossing round replay and quote succeed |
| Envio generated code | Passed | Clean Linux container installs the standalone lockfile, generates ABI/schema types and compiles handlers without cached generated files |
| Actual-model evidence | 13 rounds passed | 9,984 recorded completions, issuance, BLS beacons, roots, counts, arithmetic and cumulative logs match Monad |
| Recorded policies | 3 settled | Version 6 policies 5–7, total 105,000 test bUSDC |

The JavaScript suites contain **117 cases**. Browser interactions, integration scenarios and
contract cases are counted separately. CRE scenario tests are a source harness, not a
successful official CLI simulation or DON deployment. Software WebAuthn/PRF tests are not a
physical-device recovery recording.

The recorded response usage fields total **646,395 prompt tokens and 20,751 completion tokens**
across 9,984 completions. These are issuer-recorded response fields, not a separately metered
bill. Real wall-clock monitoring and calibration cost need separate measurement.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:indexer
pnpm test:web
pnpm test:cre
pnpm typecheck
pnpm --filter @backstop/web build
forge test --root contracts -vv
node scripts/check-campaign-resume.mjs
node scripts/ci-audit.mjs
node scripts/verify-live-evidence.mjs
node scripts/pack-cli.mjs
```

Envio code generation uses its supported Linux environment. The TypeScript suite can run on
Windows after generated types are present; use `pnpm.cmd` when PowerShell blocks its wrapper.

## Inspect the evidence

- [Actual-model and policy verification](results/evidence-audit-2026-10-04.json)
- [Responsive route checks](results/browser-audit-2026-10-04.json)
- [Browser replay interaction checks](results/browser-replay-2026-10-04.json)
- [Campaign restart result](results/campaign-resume-2026-10-04.json)
- [Dependency audit](results/security-audit-2026-10-04.json)
- [Product gallery](gallery/README.md)
- [Earlier verification and backfill artifacts](VERIFICATION_2026-10-03.md)

Provider identity remains issuer-trusted. Replay checks the recorded bytes and proven
reference material against commitments; it does not authenticate upstream serving hardware.
The statistical guarantee requires valid conditional null e-values, and the actual experiment
uses finite measured reference histograms. Historical chain records identify the September
deployment, while the revised contracts require a fresh deployment to activate their fixes.
