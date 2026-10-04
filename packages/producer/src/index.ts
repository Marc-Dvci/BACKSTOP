/**
 * The evidence producer.
 *
 * Records the exact request and raw response under a producer-controlled identity, then
 * publishes their commitment to chain. A durable checkpoint lets a restarted producer
 * publish the same response without querying the endpoint again.
 *
 * Three biases are closed by the ordering rather than by asking anyone to behave:
 *
 *   omission            the round's scheduled executions are committed at issuance, so a
 *                       missing execution is visible as a void rather than as an absence
 *   retry selection     reservation is onchain and precedes the upstream request, and a tuple
 *                       never returns to AVAILABLE
 *   inclusion selection the producer publishes, not the claimant, and it publishes before the
 *                       contributor sees the content
 *
 * A voided execution contributes the minimum e-value the calibrator can emit, e = lambda at
 * p = 1. That is the most null-favourable outcome available, so suppression is strictly worse
 * for a claimant than submitting.
 *
 * Usage
 *   backstop-producer --version 1 --rpc https://testnet-rpc.monad.xyz
 */

import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  keccakString,
  keccak,
  concatBytes,
  utf8,
  fromHex,
  roundProbes,
  buildChatRequest,
  samplingContractHash,
  digest,
  generateProbes,
  probeLeafData,
  MerkleTree,
  hashLeaf,
  type WireSamplingContract,
  countResponses,
  assignedProducer,
  CELLS,
  selectCells,
} from "@backstop/core";
import {
  auditRegistryAbi,
  ticketRegistryAbi,
  attestationRegistryAbi,
  erc20Abi,
  monadTestnet,
  deploymentFor,
  type Deployment,
} from "@backstop/sdk";

export interface ProducerConfig {
  deployment: Deployment;
  rpcUrl?: string;
  privateKey: Hex;
  versionId: bigint;
  contributor: Address;
  endpoint: { baseUrl: string; model: string; apiKey?: string };
  cellsPerRound: number;
  drawsPerCell: number;
  probeSeed: Hex;
  poolRoot: Hex;
  tMax: number;
  cellIds: string[];
  sampling: WireSamplingContract;
  samplingHash: Hex;
  attestationDigest: Hex;
  attestationManifest: Record<string, unknown>;
  evidenceDir: string;
  /** Poll interval while waiting for the next round to open. */
  pollMs: number;
}

export interface ExecutionResult {
  probeId: Hex;
  ticketId: Hex;
  state: "PUBLISHED" | "VOID";
  commitment?: Hex;
  cellId: string;
  answerIndex: number | null;
}

export function producerProbes(cfg: ProducerConfig, seed: Hex, round: number) {
  if (!Number.isSafeInteger(round) || round < 0 || round >= cfg.tMax) throw new Error("producer round is outside the committed lifetime");
  return selectCells(seed, cfg.cellIds.length, cfg.cellsPerRound).flatMap((index) =>
    roundProbes(cfg.probeSeed, cfg.poolRoot, cfg.cellIds[index]!, round, cfg.drawsPerCell, cfg.tMax));
}

export function producerRequest(cfg: ProducerConfig, probe: ReturnType<typeof producerProbes>[number]): string {
  return JSON.stringify(buildChatRequest(cfg.endpoint.model, probe, cfg.sampling));
}

/**
 * The transcript commitment.
 *
 * Binds the producer's address, declared endpoint host, request bytes and response bytes. A probe costs
 * one output token, so a transcript is a few hundred bytes and the commitment is one hash.
 */
export function transcriptCommitment(args: {
  producer: Address;
  probeId: Hex;
  request: string;
  response: string;
  serverIdentity: string;
}): Hex {
  return keccak(
    concatBytes(
      utf8("BACKSTOP/transcript@1"),
      fromHex(keccakString(args.producer.toLowerCase())),
      fromHex(args.probeId),
      fromHex(keccakString(args.serverIdentity)),
      fromHex(keccakString(args.request)),
      fromHex(keccakString(args.response)),
    ),
  );
}

export class Producer {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;

  constructor(private readonly cfg: ProducerConfig) {
    if (!cfg.evidenceDir || !/^0x[0-9a-fA-F]{64}$/.test(cfg.probeSeed) || !/^0x[0-9a-fA-F]{64}$/.test(cfg.poolRoot) ||
      !/^0x[0-9a-fA-F]{64}$/.test(cfg.attestationDigest) || !cfg.cellIds?.length || new Set(cfg.cellIds).size !== cfg.cellIds.length ||
      cfg.cellIds.some((id) => !CELLS.some((cell) => cell.id === id)) ||
      [cfg.cellsPerRound, cfg.drawsPerCell, cfg.tMax, cfg.pollMs].some((n) => !Number.isSafeInteger(n) || n <= 0) ||
      cfg.cellsPerRound > cfg.cellIds.length || samplingContractHash(cfg.sampling) !== cfg.samplingHash) {
      throw new Error("invalid producer configuration or sampling commitment");
    }
    const manifest = cfg.attestationManifest;
    if (digest(manifest) !== cfg.attestationDigest || manifest.poolRoot !== cfg.poolRoot ||
      manifest.n !== cfg.drawsPerCell || manifest.tMax !== cfg.tMax || manifest.cellsPerRound !== cfg.cellsPerRound ||
      digest(manifest.cellIds) !== digest(cfg.cellIds) || manifest.samplingContractHash !== cfg.samplingHash) {
      throw new Error("producer configuration differs from its issuance manifest");
    }
    const leaves = cfg.cellIds.flatMap((id) => generateProbes(cfg.probeSeed, id, cfg.drawsPerCell * cfg.tMax)
      .map((probe) => hashLeaf(utf8(probeLeafData(probe)))));
    if (new MerkleTree(leaves).root !== manifest.probePoolRoot) throw new Error("producer probe seed differs from the committed corpus");
    this.account = privateKeyToAccount(cfg.privateKey);
    const transport = http(cfg.rpcUrl ?? monadTestnet.rpcUrls.default.http[0]);
    this.publicClient = createPublicClient({ chain: monadTestnet, transport });
    this.walletClient = createWalletClient({ chain: monadTestnet, transport, account: this.account });
  }

  get address(): Address {
    return this.account.address;
  }

  /** Register and post the bond the attestation requires. */
  async register(bond: bigint) {
    if (bond <= 0n) throw new Error("producer bond must be positive");
    const approve = await this.walletClient.writeContract({ address: this.cfg.deployment.asset as Address, abi: erc20Abi,
      functionName: "approve", args: [this.cfg.deployment.ticketRegistry as Address, bond], chain: monadTestnet, account: this.account });
    if ((await this.publicClient.waitForTransactionReceipt({ hash: approve })).status !== "success") throw new Error("producer bond approval reverted");
    const hash = await this.walletClient.writeContract({
      address: this.cfg.deployment.ticketRegistry as Address,
      abi: ticketRegistryAbi,
      functionName: "registerProducer",
      args: [bond],
      chain: monadTestnet,
      account: this.account,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("producer registration reverted");
    return receipt;
  }

  /** The producers registered for assignment, in the order the contract holds them. */
  private async producerList(): Promise<Address[]> {
    const count = (await this.publicClient.readContract({
      address: this.cfg.deployment.ticketRegistry as Address,
      abi: ticketRegistryAbi,
      functionName: "producerCount",
    })) as bigint;

    const out: Address[] = [];
    for (let i = 0n; i < count; i++) {
      out.push(
        (await this.publicClient.readContract({
          address: this.cfg.deployment.ticketRegistry as Address,
          abi: ticketRegistryAbi,
          functionName: "producerList",
          args: [i],
        })) as Address,
      );
    }
    return out;
  }

  /**
   * Serve one open round.
   *
   * The assignment is a deterministic function of the round seed, so this producer executes
   * exactly the probes it was given and no others. A censor cannot choose its targets.
   */
  async serveRound(round: number): Promise<ExecutionResult[]> {
    const version = await this.publicClient.readContract({ address: this.cfg.deployment.attestationRegistry as Address,
      abi: attestationRegistryAbi, functionName: "getVersion", args: [this.cfg.versionId] });
    if (version.commitments.attestationDigest !== this.cfg.attestationDigest || version.commitments.referencePoolRoot !== this.cfg.poolRoot ||
      Number(version.stats.n) !== this.cfg.drawsPerCell || Number(version.stats.tMax) !== this.cfg.tMax ||
      Number(version.stats.cellsPerRound) !== this.cfg.cellsPerRound || Number(version.stats.cellCount) !== this.cfg.cellIds.length) {
      throw new Error("producer configuration differs from the chain issuance");
    }
    const r = (await this.publicClient.readContract({
      address: this.cfg.deployment.auditRegistry as Address,
      abi: auditRegistryAbi,
      functionName: "getRound",
      args: [this.cfg.versionId, round],
    })) as { state: number; seed: Hex };

    if (r.state !== 1) throw new Error(`round ${round} is not open`);

    const selected = selectCells(r.seed, this.cfg.cellIds.length, this.cfg.cellsPerRound).map(
      (i) => this.cfg.cellIds[i] as string,
    );
    const producers = await this.producerList();
    const results: ExecutionResult[] = [];

    for (const cellId of selected) {
      const cell = CELLS.find((c) => c.id === cellId);
      if (!cell) continue;

      const probes = roundProbes(
        this.cfg.probeSeed,
        this.cfg.poolRoot,
        cellId,
        round,
        this.cfg.drawsPerCell,
        this.cfg.tMax,
      );

      for (const probe of probes) {
        if (assignedProducer(r.seed, probe.probeId, producers).toLowerCase() !== this.address.toLowerCase()) continue;

        // Reservation is onchain and precedes the upstream request, so two producers cannot race
        // and a retry cannot be laundered into a fresh execution.
        const ticketId = (await this.publicClient.readContract({
          address: this.cfg.deployment.ticketRegistry as Address,
          abi: ticketRegistryAbi,
          functionName: "ticketId",
          args: [this.cfg.versionId, this.cfg.contributor, round, probe.probeId],
        })) as Hex;

        const evidencePath = join(this.cfg.evidenceDir, `${ticketId}.json`);
        const existing = await this.publicClient.readContract({ address: this.cfg.deployment.ticketRegistry as Address,
          abi: ticketRegistryAbi, functionName: "ticket", args: [ticketId] });
        if (existing.state === 0 && existsSync(evidencePath)) throw new Error("durable transcript has no corresponding chain reservation");
        if (existing.state !== 0 && (!existsSync(evidencePath) || existing.producer.toLowerCase() !== this.address.toLowerCase())) {
          // A reservation with no durable response is never repeated upstream.
          results.push({ probeId: probe.probeId, ticketId, state: "VOID", cellId, answerIndex: null });
          continue;
        }
        if (existing.state === 4) {
          results.push({ probeId: probe.probeId, ticketId, state: "VOID", cellId, answerIndex: null });
          continue;
        }
        try {
          if (existing.state === 0) {
          const reserve = await this.walletClient.writeContract({
            address: this.cfg.deployment.ticketRegistry as Address,
            abi: ticketRegistryAbi,
            functionName: "reserve",
            args: [this.cfg.versionId, this.cfg.contributor, round, probe.probeId],
            chain: monadTestnet,
            account: this.account,
          });
          if ((await this.publicClient.waitForTransactionReceipt({ hash: reserve })).status !== "success") throw new Error("reservation reverted");
          }
        } catch {
          results.push({ probeId: probe.probeId, ticketId, state: "VOID", cellId, answerIndex: null });
          continue;
        }

        const request = producerRequest(this.cfg, probe);

        let response: string | null = null;
        let content: string | null = null;
        let status = 0;
        try {
          if (existsSync(evidencePath)) {
            const saved = JSON.parse(readFileSync(evidencePath, "utf8"));
            const { checksum, ...payload } = saved;
            if (digest(payload) !== checksum || saved.request !== request || saved.probeId !== probe.probeId || saved.ticketId !== ticketId) {
              throw new Error("producer checkpoint does not match this execution");
            }
            response = saved.response; status = saved.status;
          } else {
          const res = await fetch(`${this.cfg.endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.cfg.endpoint.apiKey ? { authorization: `Bearer ${this.cfg.endpoint.apiKey}` } : {}),
            },
            body: request,
            signal: AbortSignal.timeout(30000),
          });
          status = res.status;
          response = await res.text();
          mkdirSync(this.cfg.evidenceDir, { recursive: true });
          const payload = { ticketId, probeId: probe.probeId, cellId, request, response, status };
          writeFileSync(evidencePath, JSON.stringify({ ...payload, checksum: digest(payload) }), { flag: "wx", mode: 0o600, flush: true });
          }
          if (status === 200) {
            try { const value = JSON.parse(response!).choices?.[0]?.message?.content;
              content = typeof value === "string" ? value : null; } catch { /* preserve malformed raw response */ }
          }
        } catch {
          response = null;
        }

        if (response === null) {
          // The obligation is to publish or to be voided. Not publishing costs the bond.
          results.push({ probeId: probe.probeId, ticketId, state: "VOID", cellId, answerIndex: null });
          continue;
        }

        const commitment = transcriptCommitment({
          producer: this.address,
          probeId: probe.probeId,
          request,
          response,
          serverIdentity: new URL(this.cfg.endpoint.baseUrl).host,
        });

        if (existing.state === 3 && existing.commitment !== commitment) throw new Error("published ticket differs from its durable transcript");
        if (existing.state !== 3) {
        const publish = await this.walletClient.writeContract({
          address: this.cfg.deployment.ticketRegistry as Address,
          abi: ticketRegistryAbi,
          functionName: "publish",
          args: [ticketId, commitment],
          chain: monadTestnet,
          account: this.account,
        });
        if ((await this.publicClient.waitForTransactionReceipt({ hash: publish })).status !== "success") throw new Error("publication reverted");
        }

        const { counts } = countResponses(content === null ? [] : [content], cell.alphabet);
        const answerIndex = counts.findIndex((c) => c > 0);
        results.push({
          probeId: probe.probeId,
          ticketId,
          state: "PUBLISHED",
          commitment,
          cellId,
          answerIndex: answerIndex >= 0 ? answerIndex : null,
        });
      }
    }

    return results;
  }

  /** Watch for open rounds and serve each one. */
  async run(signal?: AbortSignal): Promise<void> {
    let served = -1;
    for (;;) {
      if (signal?.aborted) return;
      const next = Number(
        (await this.publicClient.readContract({
          address: this.cfg.deployment.auditRegistry as Address,
          abi: auditRegistryAbi,
          functionName: "nextRound",
          args: [this.cfg.versionId],
        })) as number,
      );
      const open = next; // the round the issuer has opened but not closed
      if (open > served) {
        try {
          const results = await this.serveRound(open);
          const published = results.filter((r) => r.state === "PUBLISHED").length;
          const voided = results.length - published;
          console.log(`round ${open}: ${published} published, ${voided} voided`);
          served = open;
        } catch (error) {
          // Pending rounds are expected; operational errors must remain visible.
          if (!(error instanceof Error && /not open/.test(error.message))) console.error(error instanceof Error ? error.message : "producer round failed");
        }
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollMs));
    }
  }
}

export { deploymentFor };
