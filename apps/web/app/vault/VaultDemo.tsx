"use client";

import { useState } from "react";
import {
  NAMESPACE,
  derivePrf,
  fingerprint,
  sealVault,
  openVault,
  blindingFactor,
  policyCommitment,
  sealTranscript,
  openTranscript,
  type ClaimRecord,
  type SealedVault,
} from "@backstop/sdk";
import { createCredential } from "@backstop/sdk";

type Row = { namespace: string; subject: string; fingerprint: string; use: string };

const SAMPLE: ClaimRecord = {
  version: 1,
  updatedAt: Math.floor(Date.now() / 1000),
  policies: [
    {
      policyId: "1",
      versionId: "1",
      endpointLabel: "qwen3-1.7b, pinned BF16",
      credentialId: "0x…",
      startRound: 2,
      notional: "250000000000",
    },
  ],
  notes: "Watching rounds 2 onward. Nothing here is stored anywhere but in this ciphertext.",
};

export function VaultDemo({ rpId }: { rpId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [sealed, setSealed] = useState<SealedVault | null>(null);
  const [opened, setOpened] = useState<ClaimRecord | null>(null);
  const [commitment, setCommitment] = useState<{ blinding: string; commitment: string } | null>(null);
  const [transcript, setTranscript] = useState<{ sealed: SealedVault; opened?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credId, setCredId] = useState<ArrayBuffer | undefined>(undefined);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createPasskey = () =>
    guard(async () => {
      const cred = await createCredential({
        rpId,
        rpName: "BACKSTOP vault",
        userName: "vault",
        userDisplayName: "BACKSTOP vault",
      });
      setCredId(cred.rawId);
    });

  const deriveAll = () =>
    guard(async () => {
      const out: Row[] = [];
      const vault = await derivePrf(rpId, NAMESPACE.vault, "", credId);
      out.push({
        namespace: NAMESPACE.vault,
        subject: "—",
        fingerprint: await fingerprint(vault),
        use: "AES-GCM key for the claim record",
      });

      const blindA = await derivePrf(rpId, NAMESPACE.blinding, "policy-1", credId);
      out.push({
        namespace: NAMESPACE.blinding,
        subject: "policy-1",
        fingerprint: await fingerprint(blindA),
        use: "blinding factor for policy 1",
      });

      const blindB = await derivePrf(rpId, NAMESPACE.blinding, "policy-2", credId);
      out.push({
        namespace: NAMESPACE.blinding,
        subject: "policy-2",
        fingerprint: await fingerprint(blindB),
        use: "blinding factor for policy 2",
      });

      const producer = await derivePrf(rpId, NAMESPACE.producer, "1", credId);
      out.push({
        namespace: NAMESPACE.producer,
        subject: "version 1",
        fingerprint: await fingerprint(producer),
        use: "transcript sealing key",
      });

      setRows(out);
    });

  const seal = () =>
    guard(async () => {
      setSealed(await sealVault(rpId, SAMPLE, credId));
      setOpened(null);
    });

  const open = () =>
    guard(async () => {
      if (!sealed) throw new Error("seal the vault first");
      setOpened(await openVault(rpId, sealed, credId));
    });

  const commit = () =>
    guard(async () => {
      const digest = `0x${"a3".repeat(32)}`;
      const b = await blindingFactor(rpId, digest, credId);
      setCommitment({ blinding: b, commitment: await policyCommitment(digest, b) });
    });

  const sealBytes = () =>
    guard(async () => {
      const payload = new TextEncoder().encode(
        JSON.stringify({ probeId: "0x…", request: "…", response: "3", producer: "0x…" }),
      );
      const s = await sealTranscript(rpId, "1", payload, credId);
      const back = await openTranscript(rpId, "1", s, credId);
      setTranscript({ sealed: s, opened: new TextDecoder().decode(back) });
    });

  return (
    <>
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">One passkey, four keys, no wallet</span>
        </div>
        <div className="panel-body">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
            <button className="btn" onClick={createPasskey} disabled={busy}>
              {credId ? "Passkey ready" : "1. Create a passkey"}
            </button>
            <button className="btn btn-primary" onClick={deriveAll} disabled={busy}>
              2. Derive every namespace
            </button>
          </div>

          {rows.length > 0 && (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Namespace</th>
                    <th>Subject</th>
                    <th>Derived fingerprint</th>
                    <th>What it does</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.namespace}-${r.subject}`}>
                      <td>{r.namespace}</td>
                      <td>{r.subject}</td>
                      <td style={{ color: "var(--cyan)" }}>{r.fingerprint}</td>
                      <td style={{ color: "var(--text-dim)" }}>{r.use}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="hint" style={{ marginTop: 14 }}>
            Two subjects inside one namespace derive unrelated keys, and no namespace can be
            mistaken for another. Run this on a second device with the same passkey and the four
            fingerprints reproduce exactly.
          </p>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 20 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Claim vault</span>
          </div>
          <div className="panel-body">
            <p className="prose" style={{ fontSize: 13, marginBottom: 14 }}>
              The record of which policies you hold, which credential authorises each, and which
              rounds you are watching. Sealed under the vault namespace. The ciphertext is public;
              the key exists only while the passkey is being touched, and is never written down.
            </p>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <button className="btn" onClick={seal} disabled={busy}>
                Seal
              </button>
              <button className="btn" onClick={open} disabled={busy || !sealed}>
                Open on this device
              </button>
            </div>
            {sealed && (
              <pre
                style={{
                  background: "var(--bg-raised)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 12,
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  overflowX: "auto",
                  color: "var(--text-faint)",
                  margin: 0,
                }}
              >
                {sealed.ciphertext.slice(0, 220)}…
              </pre>
            )}
            {opened && (
              <pre
                style={{
                  background: "var(--bg-raised)",
                  border: "1px solid var(--accent-dim)",
                  borderRadius: 6,
                  padding: 12,
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  overflowX: "auto",
                  marginTop: 10,
                }}
              >
                {JSON.stringify(opened, null, 2)}
              </pre>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Reproducible commitment</span>
          </div>
          <div className="panel-body">
            <p className="prose" style={{ fontSize: 13, marginBottom: 14 }}>
              A buyer who wants to prove they held a policy before a crossing publishes
              H(policyDigest ‖ blinding) at inception and opens it later. The blinding factor is
              derived from the blinding namespace at the policy digest, so the commitment
              reproduces on any device and a lost device loses nothing.
            </p>
            <button className="btn" onClick={commit} disabled={busy}>
              Derive and commit
            </button>
            {commitment && (
              <dl className="kv" style={{ marginTop: 14 }}>
                <dt>blinding</dt>
                <dd style={{ color: "var(--text-faint)" }}>{commitment.blinding.slice(0, 34)}…</dd>
                <dt>commitment</dt>
                <dd style={{ color: "var(--cyan)" }}>{commitment.commitment.slice(0, 34)}…</dd>
              </dl>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Producer transcript sealing</span>
        </div>
        <div className="panel-body">
          <p className="prose" style={{ fontSize: 13, marginBottom: 14 }}>
            The commitment published on chain binds the request and response bytes. The bytes
            themselves are sealed under the producer namespace, scoped to the attestation version,
            so an operator opens them on any machine holding the passkey and no secret is written
            to the producer&rsquo;s disk.
          </p>
          <button className="btn" onClick={sealBytes} disabled={busy}>
            Seal and reopen a transcript
          </button>
          {transcript?.opened && (
            <pre
              style={{
                background: "var(--bg-raised)",
                border: "1px solid var(--accent-dim)",
                borderRadius: 6,
                padding: 12,
                fontSize: 11,
                fontFamily: "var(--mono)",
                overflowX: "auto",
                marginTop: 12,
              }}
            >
              {transcript.opened}
            </pre>
          )}
        </div>
      </div>

      {error && (
        <div className="panel" style={{ marginTop: 16, borderColor: "rgba(248,113,113,0.35)" }}>
          <div className="panel-body" style={{ color: "var(--alarm)", fontSize: 13 }}>
            {error}
          </div>
        </div>
      )}
    </>
  );
}
