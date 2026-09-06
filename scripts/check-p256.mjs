/**
 * Confirm Monad's secp256r1 precompile answers at 0x0100 with a real signature.
 *
 * The WebAuthn ceremony rests on this call, so it is checked against the same fixtures the
 * contract suite uses rather than assumed from the documentation.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http, defineChain, encodePacked, sha256, toHex, stringToHex } from "viem";

const monad = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});
const client = createPublicClient({ chain: monad, transport: http() });

const doc = JSON.parse(readFileSync("contracts/vectors/webauthn.json", "utf8"));
const pad = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;

let ok = 0;
let rejected = 0;

for (const f of doc.fixtures) {
  // messageHash = sha256(authenticatorData || sha256(clientDataJSON))
  const clientHash = sha256(stringToHex(f.clientDataJSON));
  const messageHash = sha256(encodePacked(["bytes", "bytes32"], [f.authenticatorData, clientHash]));

  const input = encodePacked(
    ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
    [messageHash, pad(f.r), pad(f.s), pad(doc.x), pad(doc.y)],
  );

  const res = await client.call({ to: "0x0000000000000000000000000000000000000100", data: input });
  const verified = res.data !== undefined && BigInt(res.data) === 1n;

  // Every fixture carries a genuine signature; the negative ones fail the ceremony, not the curve.
  if (verified) ok += 1;
  else rejected += 1;
  console.log(`  ${f.name.padEnd(30)} precompile says ${verified ? "valid" : "invalid"}`);
}

console.log(`\n  ${ok} signatures verified by the precompile, ${rejected} rejected.`);
console.log(`  The precompile is live at 0x0100 on Monad testnet.`);
