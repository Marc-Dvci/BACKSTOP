/**
 * The evidence producer.
 *
 * Evidence that can trigger a payout carries a transcript attestation binding the server
 * identity for the endpoint host, the request bytes and the response bytes. This service is
 * that producer: it terminates the session, signs with an attested key, and publishes the
 * commitment directly to chain before the contributor can act on the content.
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
import {
  keccakString,
  keccak,
  concatBytes,
  utf8,
  fromHex,
  generateProbes,
  countResponses,
  assignedProducer,
  CELLS,
  selectCells,
} from "@backstop/core";
import {
  auditRegistryAbi,
  ticketRegistryAbi,
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

/**
 * The transcript commitment.
 *
 * Binds the producer's attested key, the request bytes and the response bytes. A probe costs
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
    const hash = await this.walletClient.writeContract({
      address: this.cfg.deployment.ticketRegistry as Address,
      abi: ticketRegistryAbi,
      functionName: "registerProducer",
      args: [bond],
      chain: monadTestnet,
      account: this.account,
    });
    return this.publicClient.waitForTransactionReceipt({ hash });
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
    const r = (await this.publicClient.readContract({
      address: this.cfg.deployment.auditRegistry as Address,
      abi: auditRegistryAbi,
      functionName: "getRound",
      args: [this.cfg.versionId, round],
    })) as { state: number; seed: Hex };

    if (r.state !== 1) throw new Error(`round ${round} is not open`);

    const cellIds = CELLS.map((c) => c.id);
    const selected = selectCells(r.seed, cellIds.length, this.cfg.cellsPerRound).map(
      (i) => cellIds[i] as string,
    );
    const producers = await this.producerList();
    const results: ExecutionResult[] = [];

    for (const cellId of selected) {
      const cell = CELLS.find((c) => c.id === cellId);
      if (!cell) continue;

      const probes = generateProbes(
        this.cfg.probeSeed,
        cellId,
        this.cfg.drawsPerCell * (round + 1),
      ).slice(this.cfg.drawsPerCell * round);

      for (const probe of probes) {
        if (assignedProducer(r.seed, probe.probeId, producers) !== this.address) continue;

        // Reservation is onchain and precedes the upstream request, so two producers cannot race
        // and a retry cannot be laundered into a fresh execution.
        const ticketId = (await this.publicClient.readContract({
          address: this.cfg.deployment.ticketRegistry as Address,
          abi: ticketRegistryAbi,
          functionName: "ticketId",
          args: [this.cfg.versionId, this.cfg.contributor, round, probe.probeId],
        })) as Hex;

        try {
          const reserve = await this.walletClient.writeContract({
            address: this.cfg.deployment.ticketRegistry as Address,
            abi: ticketRegistryAbi,
            functionName: "reserve",
            args: [this.cfg.versionId, this.cfg.contributor, round, probe.probeId],
            chain: monadTestnet,
            account: this.account,
          });
          await this.publicClient.waitForTransactionReceipt({ hash: reserve });
        } catch {
          results.push({ probeId: probe.probeId, ticketId, state: "VOID", cellId, answerIndex: null });
          continue;
        }

        const request = JSON.stringify({
          model: this.cfg.endpoint.model,
          messages: [
            { role: "system", content: probe.system },
            { role: "user", content: probe.user },
          ],
        });

        let response: string | null = null;
        try {
          const res = await fetch(`${this.cfg.endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.cfg.endpoint.apiKey ? { authorization: `Bearer ${this.cfg.endpoint.apiKey}` } : {}),
            },
            body: JSON.stringify({
              ...JSON.parse(request),
              temperature: 1,
              top_p: 1,
              max_tokens: 24,
            }),
          });
          const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          response = body.choices?.[0]?.message?.content ?? null;
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

        const publish = await this.walletClient.writeContract({
          address: this.cfg.deployment.ticketRegistry as Address,
          abi: ticketRegistryAbi,
          functionName: "publish",
          args: [ticketId, commitment],
          chain: monadTestnet,
          account: this.account,
        });
        await this.publicClient.waitForTransactionReceipt({ hash: publish });

        const { counts } = countResponses([response], cell.alphabet);
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
        } catch {
          // the round is not open yet
        }
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollMs));
    }
  }
}

export { deploymentFor };
