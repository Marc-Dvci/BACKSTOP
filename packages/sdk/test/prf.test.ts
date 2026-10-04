import { afterEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE, namespaceSalt, sealVault, openVault, type ClaimRecord } from "../src/prf.js";

const record: ClaimRecord = { version: 1, updatedAt: 1, policies: [], notes: "recovery test" };

// Software authenticator exercises the real HKDF/AES path without pretending to test hardware.
function authenticator(secret: string) {
  vi.stubGlobal("navigator", { credentials: { get: async (request: CredentialRequestOptions) => {
    const extensions = request.publicKey!.extensions as unknown as { prf: { eval: { first: Uint8Array } } };
    const salt = extensions.prf.eval.first;
    const input = new Uint8Array([...new TextEncoder().encode(secret), ...salt]);
    const first = await crypto.subtle.digest("SHA-256", input);
    return { getClientExtensionResults: () => ({ prf: { results: { first } } }) };
  } } });
}

afterEach(() => vi.unstubAllGlobals());
describe("portable encrypted claim record", () => {
  it("recovers the exported ciphertext with the same passkey in a fresh session", async () => {
    authenticator("original-passkey");
    const sealed = await sealVault("backstop.example", record);
    vi.unstubAllGlobals();
    authenticator("original-passkey");
    expect(await openVault("backstop.example", JSON.parse(JSON.stringify(sealed)))).toEqual(record);
  });
  it("rejects another passkey", async () => {
    authenticator("original-passkey");
    const sealed = await sealVault("backstop.example", record);
    authenticator("different-passkey");
    await expect(openVault("backstop.example", sealed)).rejects.toThrow();
  });
  it("rejects modified ciphertext", async () => {
    authenticator("original-passkey");
    const sealed = await sealVault("backstop.example", record);
    sealed.ciphertext = (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1);
    await expect(openVault("backstop.example", sealed)).rejects.toThrow();
  });
  it("separates namespace and subject salts", async () => {
    const salts = await Promise.all([
      namespaceSalt(NAMESPACE.vault, ""), namespaceSalt(NAMESPACE.blinding, "policy-1"),
      namespaceSalt(NAMESPACE.blinding, "policy-2"), namespaceSalt(NAMESPACE.producer, "1"),
    ]);
    expect(new Set(salts.map((v) => Buffer.from(v).toString("hex"))).size).toBe(4);
  });
});
