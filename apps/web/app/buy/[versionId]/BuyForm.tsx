"use client";

import { useMemo, useState } from "react";
import { createPublicClient, http, type Address, type Hex } from "viem";
import {
  policyRegistryAbi,
  erc20Abi,
  monadTestnet,
  quote,
  quoteComponents,
  createCredential,
  assert as passkeyAssert,
  type Deployment,
} from "@backstop/sdk";
import { useWallet } from "@/components/wallet";

type Stage = "idle" | "enrolling" | "quoting" | "signing" | "submitting" | "done" | "error";

export interface BuyFormProps {
  deployment: Deployment;
  versionId: number;
  endpointId: Hex;
  label: string;
  alpha: number;
  seasoningRounds: number;
  maxNotional: string;
  /** Measured power and median delay for this endpoint's departure sizes. */
  power: number;
  medianDelayRounds: number;
  departureRatePerYear: number;
  /** The attestation's round cap, and how much of it is already spent. */
  tMax: number;
  roundsClosed: number;
}

/**
 * Coverage in three actions: enrol a passkey, sign the domain-bound policy digest with it,
 * and submit. The signature is verified on chain by Monad's P256 precompile inside the full
 * WebAuthn ceremony, so what authorises the policy is the device the buyer already carries.
 */
export function BuyForm(props: BuyFormProps) {
  const [notionalUsd, setNotionalUsd] = useState(25000);
  const [termDays, setTermDays] = useState(30);
  const [stage, setStage] = useState<Stage>("idle");
  const [message, setMessage] = useState<string>("");
  const [credential, setCredential] = useState<{ id: Hex; raw: ArrayBuffer } | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);

  const q = useMemo(
    () =>
      quote({
        notional: BigInt(Math.round(notionalUsd * 1e6)),
        termSeconds: termDays * 24 * 3600,
        roundSeconds: 3600,
        seasoningRounds: props.seasoningRounds,
        alpha: props.alpha,
        departureRatePerYear: props.departureRatePerYear,
        power: props.power,
        medianDelayRounds: props.medianDelayRounds,
        tMax: props.tMax,
        roundsClosed: props.roundsClosed,
        capitalChargeAnnualBps: 800,
        poolMarginBps: 40,
      }),
    [notionalUsd, termDays, props],
  );

  const publicClient = useMemo(
    () => createPublicClient({ chain: monadTestnet, transport: http() }),
    [],
  );

  // The signer comes from whichever wallet layer the app mounted. With Dynamic configured
  // that is a Dynamic wallet, so a buyer who signed in with an email pays the premium and
  // receives the payout from an embedded wallet they never had to fund by hand.
  const wallet = useWallet();

  async function enrol() {
    try {
      setStage("enrolling");
      setMessage("Waiting for the authenticator…");
      const cred = await createCredential({
        rpId: props.deployment.rpId,
        rpName: "BACKSTOP",
        userName: "buyer",
        userDisplayName: "BACKSTOP buyer",
      });
      const { client, account } = await wallet.connect();
      setMessage("Enrolling the credential on chain…");
      const hash = await client.writeContract({
        address: props.deployment.policyRegistry as Address,
        abi: policyRegistryAbi,
        functionName: "enrollCredential",
        args: [cred.credentialId, cred.x, cred.y],
        account,
        chain: monadTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setCredential({ id: cred.credentialId, raw: cred.rawId });
      setStage("idle");
      setMessage("Passkey enrolled. It can now authorise policies on this contract.");
    } catch (err) {
      setStage("error");
      setMessage((err as Error).message);
    }
  }

  async function buy() {
    try {
      if (!credential) throw new Error("enrol a passkey first");
      const { client, account } = await wallet.connect();

      setStage("quoting");
      setMessage("Reading the current block…");
      const block = await publicClient.getBlock();
      const chainId = await publicClient.getChainId();

      const terms = {
        chainId: BigInt(chainId),
        verifyingContract: props.deployment.policyRegistry as Address,
        attestationVersion: BigInt(props.versionId),
        policyVersion: 1n,
        endpointId: props.endpointId,
        buyer: account,
        notional: BigInt(Math.round(notionalUsd * 1e6)),
        term: BigInt(termDays * 24 * 3600),
        premiumRateBps: BigInt(q.premiumRateBps),
        seasoningRounds: BigInt(props.seasoningRounds),
        nonce: BigInt(Date.now()),
        expiry: block.timestamp + 3600n,
      };

      const digest = (await publicClient.readContract({
        address: props.deployment.policyRegistry as Address,
        abi: policyRegistryAbi,
        functionName: "policyDigest",
        args: [terms],
      })) as Hex;

      setStage("signing");
      setMessage("Touch the authenticator to authorise this policy…");
      const assertion = await passkeyAssert({
        rpId: props.deployment.rpId,
        challenge: digest,
        credentialId: credential.raw,
      });

      setStage("submitting");
      setMessage("Approving the premium…");
      const approve = await client.writeContract({
        address: props.deployment.asset as Address,
        abi: erc20Abi,
        functionName: "approve",
        args: [props.deployment.policyRegistry as Address, q.premium],
        account,
        chain: monadTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: approve });

      setMessage("Submitting the policy…");
      const hash = await client.writeContract({
        address: props.deployment.policyRegistry as Address,
        abi: policyRegistryAbi,
        functionName: "purchase",
        args: [terms, assertion, credential.id, quoteComponents(q)],
        account,
        chain: monadTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setTxHash(hash);
      setStage("done");
      setMessage("Coverage is live.");
    } catch (err) {
      setStage("error");
      setMessage((err as Error).message);
    }
  }

  const busy = stage === "enrolling" || stage === "quoting" || stage === "signing" || stage === "submitting";

  return (
    <div className="grid grid-2">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Terms</span>
        </div>
        <div className="panel-body">
          <label className="field">
            <span className="field-label">Notional, USDC</span>
            <input
              type="number"
              min={1000}
              step={1000}
              value={notionalUsd}
              onChange={(e) => setNotionalUsd(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span className="field-label">Term, days</span>
            <input
              type="number"
              min={1}
              max={180}
              value={termDays}
              onChange={(e) => setTermDays(Number(e.target.value))}
            />
          </label>

          <div className="hint" style={{ marginBottom: 16 }}>
            The payoff is binary and the notional fixed. No usage metering, no token accounting, no
            price delta, no attribution. A crossing inside the term pays {notionalUsd.toLocaleString()}{" "}
            USDC.
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={enrol} disabled={busy}>
              {credential ? "Passkey enrolled" : "1. Enrol passkey"}
            </button>
            <button className="btn btn-primary" onClick={buy} disabled={busy || !credential}>
              2. Sign and take coverage
            </button>
          </div>

          {message && (
            <div
              className="hint"
              style={{ marginTop: 14, color: stage === "error" ? "var(--alarm)" : "var(--text-dim)" }}
            >
              {message}
            </div>
          )}
          {txHash && (
            <a
              className="hint"
              style={{ display: "block", marginTop: 8, color: "var(--cyan)" }}
              href={`https://testnet.monadexplorer.com/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              view the transaction
            </a>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">How this price was derived</span>
        </div>
        <div className="panel-body">
          <div className="stat" style={{ padding: 0, marginBottom: 16 }}>
            <div className="stat-label">Premium</div>
            <div className="stat-value" style={{ color: "var(--accent)" }}>
              {(Number(q.premium) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
            </div>
            <div className="stat-sub">
              {q.premiumRateBps} bps of notional, fixed at inception and never repriced
            </div>
          </div>

          <table>
            <tbody>
              <tr>
                <td>P(departure during term)</td>
                <td className="tnum">{(q.components.pDeparture * 100).toFixed(2)}%</td>
              </tr>
              <tr>
                <td>P(detected while eligible)</td>
                <td className="tnum">{(q.components.pDetectedGivenDeparture * 100).toFixed(2)}%</td>
              </tr>
              <tr>
                <td>P(false alarm)</td>
                <td className="tnum">{(q.components.pFalseAlarm * 100).toFixed(2)}%</td>
              </tr>
              <tr>
                <td>expected loss</td>
                <td className="tnum">{q.components.expectedLossBps.toFixed(1)} bps</td>
              </tr>
              <tr>
                <td>capital charge</td>
                <td className="tnum">{q.components.capitalChargeBps.toFixed(1)} bps</td>
              </tr>
              <tr>
                <td>pool margin</td>
                <td className="tnum">{q.components.poolMarginBps.toFixed(1)} bps</td>
              </tr>
              <tr>
                <td>rounds covered</td>
                <td className="tnum">{q.coveredRounds}</td>
              </tr>
              <tr>
                <td>claim-eligible rounds</td>
                <td className="tnum">{q.eligibleRounds}</td>
              </tr>
            </tbody>
          </table>

          <div className="hint" style={{ marginTop: 14 }}>
            The false-alarm term is bounded by α by construction, so the lifetime error budget is a
            priced input. P(detected) comes from the measured power and delay curve. P(departure) is a
            stated prior until the index has enough history to replace it.
          </div>
        </div>
      </div>
    </div>
  );
}
