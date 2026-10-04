import {
  CELLS, MerkleTree, hashLeaf, utf8, digest, keccakString, replayRound, verifyQuicknetBeacon, ln, countResponses,
  type RoundRecord, type DrandBeacon,
} from "@backstop/core";

export interface BrowserEvidence {
  schema: "backstop/browser-evidence@1";
  source: string;
  config: {
    version: number; poolRoot: `0x${string}`; seedChainRoot: `0x${string}`;
    cellIds: string[]; cellsPerRound: number; m: number; n: number; nR: number; tMax: number;
    alphaRay: string; lambdaRay: string; [key: string]: unknown;
    mixtureIds: string[];
  };
  record: RoundRecord & { chainId: number; auditRegistry: string; transcriptRoot: string; beacon: { round: number } };
  transcripts: { probeId: string; cellId: string; request: string; response: string; commitment: string; status: number }[];
  beacon: DrandBeacon;
}
export interface VerificationCheck { label: string; ok: boolean; detail: string }
export interface BrowserReport {
  version: number; round: number; ok: boolean; checks: VerificationCheck[];
  eRoundRay: string; logIncrementRay: string; publishedLogRay: string; responses: number;
  anchors: { attestationDigest: string; poolRoot: string; seedChainRoot: string; seed: string;
    issuerShare: string; beaconValue: string; revealRoot: string; transcriptRoot: string };
}

/** Replay is local. A separate explicit RPC check anchors these values to Monad. */
export function verifyBrowserEvidence(bundle: BrowserEvidence, modifiedCopy = false): BrowserReport {
  if (bundle.schema !== "backstop/browser-evidence@1") throw new Error("Unsupported evidence bundle");
  const { config, beacon, transcripts } = bundle;
  const record = modifiedCopy ? structuredClone(bundle.record) : bundle.record;
  if (modifiedCopy) {
    const counts = record.revealedFingerprints[0]!.counts as number[];
    const index = counts.findIndex((count) => count > 0);
    counts[index] = counts[index]! - 1;
    const destination = (index + 1) % counts.length;
    counts[destination] = counts[destination]! + 1;
  }
  const { version: _version, ...issuance } = config;
  const attestationDigest = digest(issuance);
  const replay = replayRound(record, {
    attestationVersion: config.version, attestationDigest, n: config.n, nR: config.nR,
    seedChainRoot: config.seedChainRoot, referencePoolRoot: config.poolRoot,
    cellIds: config.cellIds, cellsPerRound: config.cellsPerRound,
    params: { poolRoot: config.poolRoot, m: config.m, tMax: config.tMax,
      alphaRay: BigInt(config.alphaRay), lambdaRay: BigInt(config.lambdaRay), mixtureIds: config.mixtureIds },
  });
  const checks: VerificationCheck[] = Object.entries(replay.checks).map(([label, ok]) => ({
    label: ({ seedChain: "Committed seed chain", seedCombination: "Combined round seed", cellSelection: "Selected cells",
      fingerprintProofs: "Reference fingerprint proofs", calibrationProofs: "Calibration proofs and schedule" } as Record<string, string>)[label]!,
    ok, detail: label === "calibrationProofs" ? `${record.revealedBlocks.length.toLocaleString()} proven calibration blocks` : "Recomputed from the supplied evidence",
  }));
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });
  add("Issuance identity", record.attestationVersion === config.version && record.attestationDigest === attestationDigest,
    "Canonical attestation digest matches the round");
  let beaconOK = false;
  try { beaconOK = verifyQuicknetBeacon(beacon, record.beacon.round) === record.beaconValue; } catch { /* report failure */ }
  add("Quicknet BLS signature", beaconOK, `Public beacon round ${record.beacon.round.toLocaleString()}`);
  const commitmentOK = transcripts.length === config.n * config.cellsPerRound &&
    new Set(transcripts.map((t) => t.probeId)).size === transcripts.length &&
    transcripts.every((t) => keccakString(`${t.request}\n${t.response}`) === t.commitment);
  const transcriptRoot = new MerkleTree(transcripts.map((t) => hashLeaf(utf8(`${t.probeId}|${t.commitment}`)))).root;
  add("Recorded response commitments", commitmentOK && transcriptRoot === record.transcriptRoot,
    `${transcripts.length.toLocaleString()} request/response records reproduce the sealed root`);
  let normalised = commitmentOK && transcripts.length === record.transcripts.length;
  const byId = new Map(record.transcripts.map((t) => [t.probeId, t]));
  for (const transcript of transcripts) {
    const declared = byId.get(transcript.probeId);
    normalised &&= !!declared && declared.commitment === transcript.commitment && declared.state === "PUBLISHED";
  }
  for (const obs of record.observations) {
    const cell = CELLS.find((c) => c.id === obs.cellId);
    const rows = transcripts.filter((t) => t.cellId === obs.cellId);
    if (!cell || obs.voided || rows.length !== config.n || rows.some((t) => t.status !== 200)) { normalised = false; continue; }
    try {
      const responses = rows.map((t) => JSON.parse(t.response).choices?.[0]?.message?.content);
      if (responses.some((text) => typeof text !== "string")) { normalised = false; continue; }
      const observed = countResponses(responses, cell.alphabet);
      normalised &&= observed.unmatched === 0 && observed.counts.join() === obs.counts.join();
    } catch { normalised = false; }
  }
  add("Response counts", normalised, "Normalising the recorded model outputs reproduces the observations");
  add("Canonical verdict", replay.ok, "Integer arithmetic reproduces the published round e-value");
  return { version: config.version, round: record.round, ok: checks.every((c) => c.ok), checks,
    eRoundRay: replay.recomputed.eRoundRay.toString(), logIncrementRay: ln(replay.recomputed.eRoundRay).toString(),
    publishedLogRay: record.verdict.logVersionRay, responses: transcripts.length,
    anchors: { attestationDigest, poolRoot: config.poolRoot, seedChainRoot: config.seedChainRoot,
      seed: record.seed, issuerShare: record.issuerShare, beaconValue: record.beaconValue,
      revealRoot: digest({ revealedFingerprints: record.revealedFingerprints, revealedBlocks: record.revealedBlocks }), transcriptRoot },
  };
}
