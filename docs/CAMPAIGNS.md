# Continue one audit campaign

The CLI can retain cumulative evidence across invocations. `--rounds` means additional
rounds; `--state` identifies the campaign to continue.

```bash
node packages/cli/dist/index.js audit \
  --attestation attestations/my-endpoint.json --pool pools/my-endpoint.json \
  --state my-endpoint.campaign.json --rounds 2 --json report.json
# Run the same command again to add rounds 2 and 3.
```

The state binds the attestation digest, effective endpoint URL and model. Each restart checks
the checksum, committed schedule, observed counts and every saved verdict, then recomputes the
running product. A changed attestation, endpoint or model requires a different campaign.
An already crossed campaign remains crossed and makes no more model requests.

A round becomes in flight before requests start. If the process stops, its next invocation
consumes that round as conservative void evidence and advances to the next calibration slice.
Incomplete samples are also consumed as void evidence and return exit code 2. Failed requests
are not silently dropped. The total campaign cannot exceed the committed `tMax`.

State writes use a flushed temporary file and atomic rename. An exclusive `.lock` prevents
concurrent jobs from consuming one slice. After a crash, check that the recorded process has
stopped before removing its lock. Retain the state itself.

## GitHub Action

The action accepts `campaign-state: my-endpoint.campaign.json`. Restore the file before the
action and save the updated file even when the audit returns a crossing or incomplete run.
Serialize jobs for that endpoint with the workflow's concurrency controls. A cache or
artifact that is restored only on success can discard evidence. Keep the state outside
untrusted pull-request modifications and preserve it when the code checkout changes.

This is operator-managed local state. Its checksum detects accidental changes; an operator
can rewrite it or delete it. The standalone CLI uses a deterministic local seed schedule,
not the BLS beacon schedule of the onchain runner. Do not attribute onchain ordering or a
fresh lifetime error budget to arbitrary resets. Start a new reference campaign through an
explicit review of its calibration and statistical assumptions.

## Check restart behavior

```bash
pnpm build
node scripts/check-campaign-resume.mjs
```

The check compares four uninterrupted rounds with two plus two resumed rounds against the
same deterministic reference stream. Counts and verdicts must match exactly; measured HTTP
latencies are excluded. It also simulates an interrupted fifth round and verifies that its
slice is voided and never reused.
