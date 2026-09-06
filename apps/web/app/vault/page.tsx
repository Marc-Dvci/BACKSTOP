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
        passkey therefore mints unlimited unrelated keys, all reconstructible from the passkey
        alone, with nothing sensitive stored on disk or on a server. BACKSTOP uses that primitive
        three times and none of the three signs a blockchain transaction.
      </p>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">The cross-device test</span>
        </div>
        <div className="panel-body prose" style={{ fontSize: 13 }}>
          <p style={{ marginBottom: 0 }}>
            Derive the namespaces here, seal the claim record, then open this page in a fresh
            browser profile or on a second device with the same passkey. The four fingerprints
            reproduce exactly and the same ciphertext opens. Nothing was carried across: the
            keys are recomputed from the passkey, and the only thing that ever left this device
            is a ciphertext anyone may hold.
          </p>
        </div>
      </div>

      <VaultDemo rpId={d.rpId} />
    </div>
  );
}
