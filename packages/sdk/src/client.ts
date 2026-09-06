/**
 * The BACKSTOP client.
 *
 * Four things a developer does with the protocol: read the index, buy coverage, run or
 * support an audit, and redeem a claim. Each is one call here.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  attestationRegistryAbi,
  auditRegistryAbi,
  coveragePoolAbi,
  policyRegistryAbi,
  settlementAbi,
  ticketRegistryAbi,
  erc20Abi,
} from "./abi.js";
import { monadTestnet } from "./chains.js";
import { quote, quoteComponents, type QuoteInputs } from "./quote.js";

const RAY = 10n ** 27n;

export interface Deployment {
  chainId: number;
  attestationRegistry: Address;
  auditRegistry: Address;
  coveragePool: Address;
  policyRegistry: Address;
  settlement: Address;
  ticketRegistry: Address;
  asset: Address;
  rpOrigin: string;
  rpId: string;
}

export interface ClientOptions {
  deployment: Deployment;
  chain?: Chain;
  rpcUrl?: string;
  account?: Account;
}

export interface EndpointStatus {
  versionId: bigint;
  endpointId: Hex;
  issuer: Address;
  settlementEligible: boolean;
  closedRounds: number;
  /** log M_version at the latest closed round, RAY scale. */
  versionLogRay: bigint;
  boundaryRay: bigint;
  warningLogRay: bigint;
  inWarningRegion: boolean;
  voidRateBps: bigint;
  /** Fraction of the way to the Ville boundary, in basis points. */
  progressBps: number;
}

export interface PolicyStatus {
  policyId: bigint;
  buyer: Address;
  versionId: bigint;
  notional: bigint;
  startRound: number;
  inceptionRound: number;
  expiryAt: number;
  status: number;
  policyLogRay: bigint;
  boundaryRay: bigint;
  progressBps: number;
}

export class BackstopClient {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient<Transport, Chain, Account>;
  readonly deployment: Deployment;

  constructor(opts: ClientOptions) {
    const chain = opts.chain ?? monadTestnet;
    const transport = http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]);
    // Reads are coalesced through Multicall3. Reading an endpoint's status is eight calls, and
    // sending those individually is a burst public RPCs rate-limit.
    this.publicClient = createPublicClient({
      chain,
      transport,
      batch: { multicall: { batchSize: 1024, wait: 16 } },
    });
    this.deployment = opts.deployment;
    if (opts.account) {
      this.walletClient = createWalletClient({ chain, transport, account: opts.account });
    }
  }

  private requireWallet(): WalletClient<Transport, Chain, Account> {
    if (!this.walletClient) throw new Error("this call needs an account; construct the client with one");
    return this.walletClient;
  }

  // ---------------------------------------------------------------- reading the index

  /** Every attestation version ever issued, newest first. */
  async versions(): Promise<bigint[]> {
    const count = (await this.publicClient.readContract({
      address: this.deployment.attestationRegistry,
      abi: attestationRegistryAbi,
      functionName: "versionCount",
    })) as bigint;
    return Array.from({ length: Number(count) }, (_, i) => BigInt(Number(count) - i));
  }

  async endpointStatus(versionId: bigint): Promise<EndpointStatus> {
    const a = this.deployment.attestationRegistry;
    const u = this.deployment.auditRegistry;

    const [version, eligible, boundaryRay, warningLogRay, closedRounds, versionLogRay, warning, voidRateBps] =
      await Promise.all([
        this.publicClient.readContract({ address: a, abi: attestationRegistryAbi, functionName: "getVersion", args: [versionId] }),
        this.publicClient.readContract({ address: a, abi: attestationRegistryAbi, functionName: "settlementEligible", args: [versionId] }),
        this.publicClient.readContract({ address: a, abi: attestationRegistryAbi, functionName: "boundaryRay", args: [versionId] }),
        this.publicClient.readContract({ address: a, abi: attestationRegistryAbi, functionName: "warningLogRay", args: [versionId] }),
        this.publicClient.readContract({ address: u, abi: auditRegistryAbi, functionName: "closedRounds", args: [versionId] }),
        this.publicClient.readContract({ address: u, abi: auditRegistryAbi, functionName: "versionLog", args: [versionId] }),
        this.publicClient.readContract({ address: u, abi: auditRegistryAbi, functionName: "inWarningRegion", args: [versionId] }),
        this.publicClient.readContract({ address: u, abi: auditRegistryAbi, functionName: "voidRateBps", args: [versionId] }),
      ]);

    const v = version as { issuer: Address; endpointId: Hex };
    const log = versionLogRay as bigint;
    const bound = boundaryRay as bigint;

    return {
      versionId,
      endpointId: v.endpointId,
      issuer: v.issuer,
      settlementEligible: eligible as boolean,
      closedRounds: Number(closedRounds as number),
      versionLogRay: log,
      boundaryRay: bound,
      warningLogRay: warningLogRay as bigint,
      inWarningRegion: warning as boolean,
      voidRateBps: voidRateBps as bigint,
      progressBps: bound === 0n ? 0 : Number((log * 10000n) / bound),
    };
  }

  /** Every closed round for a version, oldest first. */
  async rounds(versionId: bigint) {
    const closed = Number(
      (await this.publicClient.readContract({
        address: this.deployment.auditRegistry,
        abi: auditRegistryAbi,
        functionName: "closedRounds",
        args: [versionId],
      })) as number,
    );
    const out = [];
    for (let i = 0; i < closed; i++) {
      const r = (await this.publicClient.readContract({
        address: this.deployment.auditRegistry,
        abi: auditRegistryAbi,
        functionName: "getRound",
        args: [versionId, i],
      })) as Record<string, unknown>;
      out.push({ index: i, ...r });
    }
    return out;
  }

  // ---------------------------------------------------------------- coverage

  /** The premium this endpoint would be quoted right now, with every component. */
  price(inputs: QuoteInputs) {
    return quote(inputs);
  }

  /** Enrol a passkey public key so it can authorise policies for this account. */
  async enrollCredential(credentialId: Hex, x: bigint, y: bigint) {
    const wallet = this.requireWallet();
    return wallet.writeContract({
      address: this.deployment.policyRegistry,
      abi: policyRegistryAbi,
      functionName: "enrollCredential",
      args: [credentialId, x, y],
      chain: wallet.chain,
      account: wallet.account,
    });
  }

  /** The domain-bound digest a passkey assertion must sign. */
  async policyDigest(terms: PolicyTerms): Promise<Hex> {
    return (await this.publicClient.readContract({
      address: this.deployment.policyRegistry,
      abi: policyRegistryAbi,
      functionName: "policyDigest",
      args: [terms],
    })) as Hex;
  }

  /** Buy coverage. The assertion is produced by the buyer's authenticator. */
  async purchase(args: {
    terms: PolicyTerms;
    assertion: { authenticatorData: Hex; clientDataJSON: string; r: bigint; s: bigint };
    credentialId: Hex;
    quoteInputs: QuoteInputs;
  }) {
    const wallet = this.requireWallet();
    const q = quote(args.quoteInputs);
    return wallet.writeContract({
      address: this.deployment.policyRegistry,
      abi: policyRegistryAbi,
      functionName: "purchase",
      args: [args.terms, args.assertion, args.credentialId, quoteComponents(q)],
      chain: wallet.chain,
      account: wallet.account,
    });
  }

  async policy(policyId: bigint): Promise<PolicyStatus> {
    const p = (await this.publicClient.readContract({
      address: this.deployment.policyRegistry,
      abi: policyRegistryAbi,
      functionName: "policy",
      args: [policyId],
    })) as Record<string, unknown>;

    const [logRay, boundaryRay] = await Promise.all([
      this.publicClient.readContract({
        address: this.deployment.policyRegistry,
        abi: policyRegistryAbi,
        functionName: "policyLog",
        args: [policyId],
      }),
      this.publicClient.readContract({
        address: this.deployment.attestationRegistry,
        abi: attestationRegistryAbi,
        functionName: "boundaryRay",
        args: [p.versionId as bigint],
      }),
    ]);

    const log = logRay as bigint;
    const bound = boundaryRay as bigint;
    return {
      policyId,
      buyer: p.buyer as Address,
      versionId: p.versionId as bigint,
      notional: p.notional as bigint,
      startRound: Number(p.startRound),
      inceptionRound: Number(p.inceptionRound),
      expiryAt: Number(p.expiryAt),
      status: Number(p.status),
      policyLogRay: log,
      boundaryRay: bound,
      progressBps: bound === 0n || log <= 0n ? 0 : Number((log * 10000n) / bound),
    };
  }

  /** Whether a policy may claim against a given round. */
  async claimable(policyId: bigint, round: number): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.deployment.policyRegistry,
      abi: policyRegistryAbi,
      functionName: "claimable",
      args: [policyId, round],
    })) as boolean;
  }

  /** Redeem a crossing. The crossing is re-derived onchain from the cumulative logs. */
  async redeem(policyId: bigint, round: number) {
    const wallet = this.requireWallet();
    return wallet.writeContract({
      address: this.deployment.settlement,
      abi: settlementAbi,
      functionName: "redeem",
      args: [policyId, round],
      chain: wallet.chain,
      account: wallet.account,
    });
  }

  /** Settle a bounded batch against a published claim root. */
  async settleBatch(versionId: bigint, round: number, policyIds: bigint[]) {
    const wallet = this.requireWallet();
    return wallet.writeContract({
      address: this.deployment.settlement,
      abi: settlementAbi,
      functionName: "settleBatch",
      args: [versionId, round, policyIds],
      chain: wallet.chain,
      account: wallet.account,
    });
  }

  // ---------------------------------------------------------------- underwriting

  async poolState() {
    const p = this.deployment.coveragePool;
    const [totalAssets, reserved, free, maxNotional] = await Promise.all([
      this.publicClient.readContract({ address: p, abi: coveragePoolAbi, functionName: "totalAssets" }),
      this.publicClient.readContract({ address: p, abi: coveragePoolAbi, functionName: "reservedCapital" }),
      this.publicClient.readContract({ address: p, abi: coveragePoolAbi, functionName: "freeCapital" }),
      this.publicClient.readContract({ address: p, abi: coveragePoolAbi, functionName: "maxNotional" }),
    ]);
    return {
      totalAssets: totalAssets as bigint,
      reservedCapital: reserved as bigint,
      freeCapital: free as bigint,
      maxNotional: maxNotional as bigint,
      collateralisationBps:
        (reserved as bigint) === 0n ? null : Number(((totalAssets as bigint) * 10000n) / (reserved as bigint)),
    };
  }

  async deposit(amount: bigint) {
    const wallet = this.requireWallet();
    await wallet.writeContract({
      address: this.deployment.asset,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.deployment.coveragePool, amount],
      chain: wallet.chain,
      account: wallet.account,
    });
    return wallet.writeContract({
      address: this.deployment.coveragePool,
      abi: coveragePoolAbi,
      functionName: "deposit",
      args: [amount],
      chain: wallet.chain,
      account: wallet.account,
    });
  }

  // ---------------------------------------------------------------- evidence

  /** Register as an evidence producer and post the bond the attestation requires. */
  async registerProducer(bond: bigint) {
    const wallet = this.requireWallet();
    await wallet.writeContract({
      address: this.deployment.asset,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.deployment.ticketRegistry, bond],
      chain: wallet.chain,
      account: wallet.account,
    });
    return wallet.writeContract({
      address: this.deployment.ticketRegistry,
      abi: ticketRegistryAbi,
      functionName: "registerProducer",
      args: [bond],
      chain: wallet.chain,
      account: wallet.account,
    });
  }

  /** Reserve a scheduled execution before the upstream request goes out. */
  async reserveTicket(versionId: bigint, contributor: Address, round: number, probeId: Hex) {
    const wallet = this.requireWallet();
    return wallet.writeContract({
      address: this.deployment.ticketRegistry,
      abi: ticketRegistryAbi,
      functionName: "reserve",
      args: [versionId, contributor, round, probeId],
      chain: wallet.chain,
      account: wallet.account,
    });
  }

  /** Publish the transcript commitment. The producer publishes, not the claimant. */
  async publishTranscript(ticketId: Hex, commitment: Hex) {
    const wallet = this.requireWallet();
    return wallet.writeContract({
      address: this.deployment.ticketRegistry,
      abi: ticketRegistryAbi,
      functionName: "publish",
      args: [ticketId, commitment],
      chain: wallet.chain,
      account: wallet.account,
    });
  }
}

export interface PolicyTerms {
  chainId: bigint;
  verifyingContract: Address;
  attestationVersion: bigint;
  policyVersion: bigint;
  endpointId: Hex;
  buyer: Address;
  notional: bigint;
  term: bigint;
  premiumRateBps: bigint;
  seasoningRounds: bigint;
  nonce: bigint;
  expiry: bigint;
}

/** A RAY value as a decimal string, for display. */
export function formatRay(x: bigint, decimals = 4): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const whole = a / RAY;
  const frac = (a % RAY).toString().padStart(27, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
