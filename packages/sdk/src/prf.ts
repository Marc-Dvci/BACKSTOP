/**
 * The claim vault: one passkey, many keys, none of them a wallet.
 *
 * Mera's PRF output is deterministic key material, and every salt is an isolated namespace.
 * BACKSTOP uses that primitive three times, and none of the three signs a blockchain
 * transaction:
 *
 *   backstop/vault/v1          an AES-GCM key that encrypts the buyer's claim record: which
 *                              policies they hold, which credential authorises each, and the
 *                              rounds they are watching. The ciphertext is public. The key
 *                              exists only while the passkey is being touched.
 *
 *   backstop/blinding/v1       a deterministic blinding factor per policy. The buyer commits
 *                              to a policy off-chain as H(policyDigest ‖ blinding), and can
 *                              reproduce that commitment from any device without ever having
 *                              stored the blinding factor anywhere.
 *
 *   backstop/producer/v1       a transcript-sealing key for an evidence producer, so the
 *                              response bytes behind a published commitment stay encrypted at
 *                              rest and are openable by the operator on any machine that holds
 *                              the passkey.
 *
 * Nothing derived here is persisted. A fresh browser profile on a second device, given the same
 * passkey, reproduces the same three keys and opens the same state.
 *
 * The primitive is the WebAuthn PRF extension over the credential's HMAC secret, which is what
 * Mera exposes. The salts below are the namespaces.
 */

export const NAMESPACE = {
  vault: "backstop/vault/v1",
  blinding: "backstop/blinding/v1",
  producer: "backstop/producer/v1",
} as const;

export type Namespace = (typeof NAMESPACE)[keyof typeof NAMESPACE];

const enc = new TextEncoder();
const dec = new TextDecoder();

const toHex = (b: Uint8Array): string =>
  Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");

const fromHex = (s: string): Uint8Array =>
  Uint8Array.from((s.startsWith("0x") ? s.slice(2) : s).match(/.{2}/g) ?? [], (h) => parseInt(h, 16));

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A standalone ArrayBuffer over the bytes, which is what WebCrypto takes. */
const buf = (b: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
};

/**
 * The salt for one namespace, optionally scoped to a subject.
 *
 * A salt is a namespace, so two subjects inside one namespace derive unrelated keys, and a
 * change of namespace cannot be mistaken for a change of subject.
 */
export async function namespaceSalt(namespace: Namespace, subject = ""): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", buf(enc.encode(`${namespace}|${subject}`)));
  return new Uint8Array(digest);
}

/**
 * Evaluate the passkey PRF at a namespace salt.
 *
 * Returns 32 bytes of deterministic key material. The same passkey and the same salt produce
 * the same bytes on any device; a different salt produces bytes unrelated to the first.
 */
export async function derivePrf(
  rpId: string,
  namespace: Namespace,
  subject = "",
  credentialId?: ArrayBuffer,
): Promise<Uint8Array> {
  const salt = await namespaceSalt(namespace, subject);
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      userVerification: "required",
      timeout: 120_000,
      ...(credentialId ? { allowCredentials: [{ type: "public-key" as const, id: credentialId }] } : {}),
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("the authenticator returned no assertion");

  const results = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const first = results.prf?.results?.first;
  if (!first) {
    throw new Error(
      "this authenticator did not return PRF output; a PRF-capable passkey is required for the vault",
    );
  }
  return new Uint8Array(first);
}

/** HKDF-SHA256 from raw PRF bytes to a usable AES-GCM key. */
export async function keyFromPrf(prf: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", buf(prf), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(new Uint8Array(32)), info: buf(enc.encode(info)) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A stable fingerprint of derived material, for showing that two devices agree. */
export async function fingerprint(material: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf(material));
  return toHex(new Uint8Array(digest)).slice(0, 16);
}

// ---------------------------------------------------------------- the vault

export interface ClaimRecord {
  version: 1;
  updatedAt: number;
  policies: {
    policyId: string;
    versionId: string;
    endpointLabel: string;
    credentialId: string;
    startRound: number;
    notional: string;
    /** The deterministic blinding factor, recomputed rather than stored. */
    commitment?: string;
  }[];
  notes?: string;
}

export interface SealedVault {
  namespace: Namespace;
  iv: string;
  ciphertext: string;
}

/**
 * Seal a claim record.
 *
 * The ciphertext can sit anywhere: a gist, an object store, a QR code. Only the passkey opens
 * it, and nothing about the key is written to disk on either device.
 */
export async function sealVault(
  rpId: string,
  record: ClaimRecord,
  credentialId?: ArrayBuffer,
): Promise<SealedVault> {
  const prf = await derivePrf(rpId, NAMESPACE.vault, "", credentialId);
  const key = await keyFromPrf(prf, "claim-record");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    buf(enc.encode(JSON.stringify(record))),
  );
  return { namespace: NAMESPACE.vault, iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}

export async function openVault(
  rpId: string,
  sealed: SealedVault,
  credentialId?: ArrayBuffer,
): Promise<ClaimRecord> {
  const prf = await derivePrf(rpId, NAMESPACE.vault, "", credentialId);
  const key = await keyFromPrf(prf, "claim-record");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(unb64(sealed.iv)) },
    key,
    buf(unb64(sealed.ciphertext)),
  );
  return JSON.parse(dec.decode(plain)) as ClaimRecord;
}

// ---------------------------------------------------------------- blinding

/**
 * The deterministic blinding factor for one policy.
 *
 * A buyer who wants to prove they held a policy before a crossing publishes
 * H(policyDigest ‖ blinding) at inception and opens it later. The blinding factor is derived
 * rather than stored, so the commitment reproduces on a second device with nothing carried
 * across, and a lost device loses nothing.
 */
export async function blindingFactor(
  rpId: string,
  policyDigest: string,
  credentialId?: ArrayBuffer,
): Promise<string> {
  const prf = await derivePrf(rpId, NAMESPACE.blinding, policyDigest, credentialId);
  return `0x${toHex(prf)}`;
}

export async function policyCommitment(policyDigest: string, blinding: string): Promise<string> {
  const material = new Uint8Array([...fromHex(policyDigest), ...fromHex(blinding)]);
  const digest = await crypto.subtle.digest("SHA-256", buf(material));
  return `0x${toHex(new Uint8Array(digest))}`;
}

// ---------------------------------------------------------------- producer sealing

/**
 * A transcript-sealing key for an evidence producer.
 *
 * The commitment published on chain binds the request and response bytes. The bytes themselves
 * are sealed under this key, so an operator can open them on any machine holding the passkey
 * and nobody else can, and no secret is written to the producer's disk.
 */
export async function sealTranscript(
  rpId: string,
  versionId: string,
  payload: Uint8Array,
  credentialId?: ArrayBuffer,
): Promise<SealedVault> {
  const prf = await derivePrf(rpId, NAMESPACE.producer, versionId, credentialId);
  const key = await keyFromPrf(prf, `transcript-${versionId}`);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload.slice());
  return { namespace: NAMESPACE.producer, iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}

export async function openTranscript(
  rpId: string,
  versionId: string,
  sealed: SealedVault,
  credentialId?: ArrayBuffer,
): Promise<Uint8Array> {
  const prf = await derivePrf(rpId, NAMESPACE.producer, versionId, credentialId);
  const key = await keyFromPrf(prf, `transcript-${versionId}`);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(unb64(sealed.iv)) },
    key,
    buf(unb64(sealed.ciphertext)),
  );
  return new Uint8Array(plain);
}

/** Whether this browser and authenticator can produce PRF output at all. */
export async function prfAvailable(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.credentials) return false;
  return typeof PublicKeyCredential !== "undefined";
}
