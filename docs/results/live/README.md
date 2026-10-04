# Actual model round records

The public evidence branch contains the actual Qwen3-1.7B campaign, including committed response transcripts, observations, revealed reference slices and verdicts.

```bash
node scripts/live/replay.mjs --version 6 --round 5
node scripts/live/verify-transcripts.mjs --version 6 --round 5
node scripts/verify-live-evidence.mjs
```

Replay verifies reference proofs and canonical arithmetic. Transcript verification reproduces the root sealed on Monad and the normalised counts from the issuer-recorded bytes. The full verifier anchors all 13 rounds and three settled policies to the public deployment.

The local `v6-round-5.json` is a convenience cache for the standalone package verification. The unit suite uses the committed seeded fixture in `docs/results/round-primary-crossing.json`.
