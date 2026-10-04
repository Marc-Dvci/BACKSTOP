import { VaultDemo } from "./VaultDemo";
import { deployment } from "@/lib/chain";

export const metadata = { title: "Claim vault · BACKSTOP" };

export default function VaultPage() {
  const d = deployment();
  return (
    <div style={{ padding: "36px 0" }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: "0 0 10px" }}>Claim vault</h1>
      <p className="prose" style={{ marginBottom: 26 }}>
        A passkey PRF is deterministic key material, and every salt is an isolated namespace. One
        passkey therefore derives separate keys for each namespace, reconstructible from the passkey
        on a compatible authenticator. BACKSTOP uses that primitive
        three times and none of the three signs a blockchain transaction.
      </p>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Recover your claim record</span>
        </div>
        <div className="panel-body prose" style={{ fontSize: 13 }}>
          <p style={{ marginBottom: 0 }}>
            Derive the namespaces here, seal the claim record, then open this page in a fresh
            browser profile or on a second device with the same passkey. The four fingerprints
            reproduce exactly and the same ciphertext opens. Copy the complete encrypted export
            into the vault panel on the second device and choose “Import and open with an existing passkey”.
            Recovery needs the original passkey, a compatible PRF implementation, the same site domain,
            and the encrypted record.
          </p>
        </div>
      </div>

      <VaultDemo rpId={d.rpId} />
    </div>
  );
}
