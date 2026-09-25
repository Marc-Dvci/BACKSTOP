import "server-only";

import { parseAbi, type Address } from "viem";
import { client } from "./chain";
import live from "../../../attestations/live.json";

/**
 * The live cadence's published material.
 *
 * Each round a live version closes on chain has a record on the live-data branch: the seed
 * material, the observed counts, a commitment per transcript, and the calibration slice the round
 * consumed with a proof per block. The transcripts themselves sit beside it, compressed. This
 * reads the branch's index of those files, and the provider's ERC-8004 reputation the cadence
 * writes after every round.
 */

export const LIVE_DATA = "https://raw.githubusercontent.com/Marc-Dvci/BACKSTOP/live-data";
export const LIVE_DATA_TREE = "https://github.com/Marc-Dvci/BACKSTOP/tree/live-data";
export const REPUTATION_REGISTRY: Address = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

export interface LiveRound {
  round: number;
  served: string;
  closedAt: number;
  drandRound: number;
  eRound: number;
  logM: number;
  verdict: string;
  completions: number;
  voided: number;
  record: string;
  transcripts: string;
}

interface LiveIndex {
  updatedAt: number;
  versions: Record<string, { key: string; label: string; rounds: LiveRound[] }>;
}

export const liveState = live as {
  issuer: Address;
  provider: { address: Address; agentId: string; agentURI: string };
  versions?: Record<string, { versionId: number; attestation: string; label: string; policies?: number[] }>;
};

export async function getLiveRounds(versionId: number): Promise<LiveRound[] | null> {
  try {
    const res = await fetch(`${LIVE_DATA}/index.json`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const index = (await res.json()) as LiveIndex;
    return index.versions[String(versionId)]?.rounds ?? null;
  } catch {
    return null;
  }
}

export function liveKeyOf(versionId: number): string | null {
  for (const [key, v] of Object.entries(liveState.versions ?? {})) if (v.versionId === versionId) return key;
  return null;
}

/** The provider's reputation as the auditor wrote it, read from the ERC-8004 registry. */
export async function getProviderReputation(): Promise<{ count: number; value: number } | null> {
  try {
    const [count, value, decimals] = (await client().readContract({
      address: REPUTATION_REGISTRY,
      abi: parseAbi([
        "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64, int128, uint8)",
      ]),
      functionName: "getSummary",
      args: [BigInt(liveState.provider.agentId), [liveState.issuer], "backstop.logM", ""],
    })) as [bigint, bigint, number];
    return { count: Number(count), value: Number(value) / 10 ** decimals };
  } catch {
    return null;
  }
}
