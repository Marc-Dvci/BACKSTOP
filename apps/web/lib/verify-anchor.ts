import type { BrowserReport } from "./verify-evidence";

export interface ChainAnchor {
  chainId: number; auditRegistry: string;
  commitments: { attestationDigest: string; referencePoolRoot: string; seedChainRoot: string };
  round: { state: number; seed: string; issuerShare: string; beaconValue: string; revealRoot: string; transcriptRoot: string;
    eRoundRay: bigint; cumLogRay: bigint; scheduled: number; voided: number };
  priorLogRay: bigint;
}

export function verifyAnchor(report: BrowserReport, chain: ChainAnchor, expectedRegistry: string): boolean {
  const a = report.anchors, c = chain.commitments, r = chain.round;
  const equal = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  return report.ok && chain.chainId === 10143 && equal(chain.auditRegistry, expectedRegistry) && r.state === 3 &&
    equal(a.attestationDigest, c.attestationDigest) && equal(a.poolRoot, c.referencePoolRoot) && equal(a.seedChainRoot, c.seedChainRoot) &&
    ["seed", "issuerShare", "beaconValue", "revealRoot", "transcriptRoot"].every((key) => equal(a[key as keyof typeof a], r[key as "seed"])) &&
    r.eRoundRay === BigInt(report.eRoundRay) && r.cumLogRay === BigInt(report.publishedLogRay) &&
    r.cumLogRay === chain.priorLogRay + BigInt(report.logIncrementRay) && r.scheduled === report.responses && r.voided === 0;
}
