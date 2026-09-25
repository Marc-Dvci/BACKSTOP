/**
 * One-time setup for the live cadence. Every step checks the chain first, so it is safe to rerun.
 *
 *   1. Keys. A dedicated issuer key runs the cadence from CI, so the governance key never leaves
 *      the machine it was created on. A separate provider key owns the endpoint's ERC-8004
 *      identity, because the Reputation Registry refuses feedback from an agent's own owner.
 *      Missing keys and secrets are generated into .env; nothing secret is printed.
 *   2. The issuer is registered in AttestationRegistry under the auditor's agentId, and the
 *      coverage pool is told it may underwrite that issuer's versions.
 *   3. The issuer becomes agent 1824's declared `agentWallet`, so feedback it writes is
 *      attributable to the auditor through the Identity Registry itself.
 *   4. The provider registers the endpoint as its own agent.
 *   5. Both keys are funded with testnet MON from the deployer.
 *   6. The two observed placeholder versions are retired in favour of the live ones.
 *
 * Usage
 *   node --env-file=.env scripts/live/setup.mjs [--fund-issuer 1.0] [--fund-provider 0.05]
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseAbi, parseEther, decodeEventLog } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ROOT,
  arg,
  abis,
  deployment,
  publicClient,
  walletFor,
  requireEnv,
  send,
  read,
  fmtMon,
  IDENTITY_REGISTRY,
  AUDITOR_AGENT_ID,
} from "./common.mjs";

const ENV = join(ROOT, ".env");
const STATE = join(ROOT, "attestations", "live.json");

// ---------------------------------------------------------------- 1. keys

const fresh = {
  LIVE_ISSUER_KEY: () => generatePrivateKey(),
  PROVIDER_KEY: () => generatePrivateKey(),
  LIVE_SEED_SECRET: () => `0x${randomBytes(32).toString("hex")}`,
  LIVE_POOL_SECRET: () => `0x${randomBytes(32).toString("hex")}`,
  LIVE_PROBE_SECRET: () => `0x${randomBytes(32).toString("hex")}`,
};
const envText = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
for (const [name, make] of Object.entries(fresh)) {
  if (!process.env[name] && !new RegExp(`^${name}=.+`, "m").test(envText)) {
    const value = make();
    appendFileSync(ENV, `${envText.endsWith("\n") ? "" : "\n"}${name}=${value}\n`);
    process.env[name] = value;
    console.log(`  generated ${name} into .env`);
  }
}

const deployer = walletFor(requireEnv("DEPLOYER_PRIVATE_KEY"));
const issuer = walletFor(requireEnv("LIVE_ISSUER_KEY"));
const provider = walletFor(requireEnv("PROVIDER_KEY"));
console.log(`  deployer ${deployer.account.address}`);
console.log(`  issuer   ${issuer.account.address}`);
console.log(`  provider ${provider.account.address}`);

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.issuer = issuer.account.address;
state.provider = { address: provider.account.address, ...(state.provider ?? {}) };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");

const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

// ---------------------------------------------------------------- 5. funding (first, so every later step can pay)

async function topUp(to, target) {
  const bal = await publicClient.getBalance({ address: to });
  if (bal >= target) return;
  const hash = await deployer.wallet.sendTransaction({ to, value: target - bal });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  funded ${to} to ${fmtMon(target)} MON`);
}
await topUp(issuer.account.address, parseEther(arg("fund-issuer", "1.0")));
await topUp(provider.account.address, parseEther(arg("fund-provider", "0.05")));

// ---------------------------------------------------------------- 2. issuer registration

const isIssuer = await read(deployment.attestationRegistry, abis.attestationRegistryAbi, "isIssuer", [
  issuer.account.address,
]);
if (!isIssuer) {
  await send(deployer.wallet, deployer.account, deployment.attestationRegistry, abis.attestationRegistryAbi, "registerIssuer", [
    issuer.account.address,
    AUDITOR_AGENT_ID,
  ]);
  console.log(`  registered the live issuer under agentId ${AUDITOR_AGENT_ID}`);
}

// The coverage pool keeps its own list of issuers whose versions it underwrites.
const poolEligible = await read(deployment.coveragePool, abis.coveragePoolAbi, "eligibleIssuer", [issuer.account.address]);
if (!poolEligible) {
  await send(deployer.wallet, deployer.account, deployment.coveragePool, abis.coveragePoolAbi, "setIssuerEligible", [
    issuer.account.address,
    true,
  ]);
  console.log("  the coverage pool underwrites the live issuer's versions");
}

// ---------------------------------------------------------------- 3. agentWallet of the auditor

const currentWallet = await read(IDENTITY_REGISTRY, identityAbi, "getAgentWallet", [AUDITOR_AGENT_ID]);
if (currentWallet.toLowerCase() !== issuer.account.address.toLowerCase()) {
  const owner = await read(IDENTITY_REGISTRY, identityAbi, "ownerOf", [AUDITOR_AGENT_ID]);
  const block = await publicClient.getBlock();
  const deadline = block.timestamp + 240n;
  const signature = await issuer.wallet.signTypedData({
    domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: 10143, verifyingContract: IDENTITY_REGISTRY },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: { agentId: AUDITOR_AGENT_ID, newWallet: issuer.account.address, owner, deadline },
  });
  await send(deployer.wallet, deployer.account, IDENTITY_REGISTRY, identityAbi, "setAgentWallet", [
    AUDITOR_AGENT_ID,
    issuer.account.address,
    deadline,
    signature,
  ]);
  console.log(`  agent ${AUDITOR_AGENT_ID} declares ${issuer.account.address} as its agentWallet`);
}

// ---------------------------------------------------------------- 4. the provider's agent

if (!state.provider.agentId) {
  const uri = "https://backstop-smoky.vercel.app/providers/backstop-reference.json";
  const receipt = await send(provider.wallet, provider.account, IDENTITY_REGISTRY, identityAbi, "register", [uri]);
  const minted = receipt.logs
    .map((l) => {
      try {
        return decodeEventLog({ abi: identityAbi, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find((e) => e?.eventName === "Transfer");
  state.provider.agentId = minted.args.tokenId.toString();
  state.provider.agentURI = uri;
  save();
  console.log(`  provider registered as agentId ${state.provider.agentId}`);
}

// ---------------------------------------------------------------- 6. retire the placeholders

for (const versionId of [3n, 4n]) {
  const v = await read(deployment.attestationRegistry, abis.attestationRegistryAbi, "getVersion", [versionId]).catch(
    () => null,
  );
  // Status: 0 None, 1 Active, 2 Retired, 3 Suspended
  if (v && (v.status === 1 || v.status === 3)) {
    await send(deployer.wallet, deployer.account, deployment.attestationRegistry, abis.attestationRegistryAbi, "retire", [
      versionId,
      "superseded by the live cadence, which audits real completions",
    ]);
    console.log(`  retired v${versionId}`);
  }
}

save();
for (const [who, w] of Object.entries({ issuer, provider, deployer })) {
  console.log(`  ${who.padEnd(9)} ${fmtMon(await publicClient.getBalance({ address: w.account.address }))} MON`);
}
