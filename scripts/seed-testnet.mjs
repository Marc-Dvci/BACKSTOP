/**
 * Stand BACKSTOP up on Monad testnet.
 *
 * Issues the attestations, funds the coverage pool, enrols a demo passkey, writes coverage, and
 * runs the audit cadence against the committed reference pool. Everything a judge clicks on the
 * live product is produced by this script and by the contracts, not by a fixture.
 *
 * Prerequisites
 *   make deploy-testnet          the six contracts, and the addresses synced everywhere
 *   node scripts/export-attestation.mjs   the committed pool and the attestation
 *
 * Usage
 *   node scripts/seed-testnet.mjs [--rounds 10] [--switch-at 5] [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import("../packages/core/dist/index.js");
const {
  RAY,
  keccakString,
  Prng,
  PoolCache,
  RunningProduct,
  evaluateRound,
  draw,
  normalise,
  mix,
  lawKey,
  generatePool,
  poolRoot,
  formatRay,
  buildSeedChain,
  roundSeed,
  selectCells,
  signAssertion,
  publicKeyFrom,
  policyDigest,
  MerkleTree,
  hashLeaf,
  fromHex,
  CANONICAL_ARITHMETIC_HASH,
  NORMALIZATION_IMPL_HASH,
} = core;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const ROUNDS = Number(arg("rounds", 10));
const SWITCH_AT = Number(arg("switch-at", 5));
const CHAIN_ID = arg("chain", "10143");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

// ---------------------------------------------------------------- inputs

const deployPath = join(ROOT, "contracts", "deployments", `${CHAIN_ID}.json`);
if (!existsSync(deployPath)) {
  console.error(`no deployment at ${deployPath}. Run: make deploy-testnet`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(deployPath, "utf8"));

const attPath = join(ROOT, "attestations", "reference.json");
if (!existsSync(attPath)) {
  console.error("no attestation. Run: node scripts/export-attestation.mjs");
  process.exit(1);
}
const att = JSON.parse(readFileSync(attPath, "utf8"));
const pool = JSON.parse(readFileSync(join(ROOT, "pools", "v1.json"), "utf8"));
const laws = JSON.parse(readFileSync(join(ROOT, "bench", "out", "laws.json"), "utf8"));

const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) {
  console.error("set DEPLOYER_PRIVATE_KEY");
  process.exit(1);
}

const monadTestnet = {
  id: Number(CHAIN_ID),
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz"] } },
};

const account = privateKeyToAccount(pk);
const transport = http(monadTestnet.rpcUrls.default.http[0]);
const publicClient = createPublicClient({ chain: monadTestnet, transport });
const wallet = createWalletClient({ account, chain: monadTestnet, transport });

const abi = (name) =>
  JSON.parse(readFileSync(join(ROOT, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8")).abi;

const A = {
  attestations: abi("AttestationRegistry"),
  audits: abi("AuditRegistry"),
  pool: abi("CoveragePool"),
  policies: abi("PolicyRegistry"),
  settlement: abi("Settlement"),
  asset: abi("MockERC20"),
};

const read = (address, contractAbi, functionName, args = []) =>
  publicClient.readContract({ address, abi: contractAbi, functionName, args });

async function write(address, contractAbi, functionName, args = []) {
  if (has("dry-run")) {
    console.log(c.dim(`   [dry-run] ${functionName}(${args.length} args)`));
    return { gasUsed: 0n };
  }
  const hash = await wallet.writeContract({
    address,
    abi: contractAbi,
    functionName,
    args,
    chain: monadTestnet,
    account,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

// ---------------------------------------------------------------- run

console.log(c.bold(`\nBACKSTOP on Monad testnet\n`));
const balance = await publicClient.getBalance({ address: account.address });
console.log(`  deployer ${account.address}`);
console.log(`  balance  ${(Number(balance) / 1e18).toFixed(4)} MON`);
if (balance === 0n && !has("dry-run")) {
  console.error(c.red("\n  the deployer has no MON. Fund it at https://faucet.monad.xyz and rerun.\n"));
  process.exit(1);
}

const CATALOGUE = [
  { key: "primary", provider: "backstop", model: "qwen3-1.7b", label: "qwen3-1.7b, pinned BF16", unknownMask: 0 },
  { key: "control", provider: "backstop", model: "qwen3-1.7b-control", label: "qwen3-1.7b, control endpoint", unknownMask: 0 },
  { key: "observed-a", provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct", label: "llama-3.3-70b-instruct, observed", unknownMask: 0b0111111 },
  { key: "observed-b", provider: "openrouter", model: "qwen/qwen3-235b-a22b", label: "qwen3-235b-a22b, observed", unknownMask: 0b0111111 },
];

const seedChain = buildSeedChain(keccakString("backstop|seed-secret|v1"), att.tMax);
const versionIds = {};

console.log(c.bold(`\n1. Attestations`));
for (const e of CATALOGUE) {
  const params = {
    endpointId: keccakString(`endpoint/${e.provider}/${e.model}`),
    providerModelKey: keccakString(`${e.provider}|${e.model}`),
    unknownFieldMask: e.unknownMask,
    seasoningRounds: att.seasoningRounds,
    stats: {
      alphaRay: BigInt(att.alphaRay),
      lambdaRay: BigInt(att.lambdaRay),
      warningRay: BigInt(att.warningRay),
      m: att.m,
      n: att.n,
      nR: att.nR,
      tMax: att.tMax,
      cellsPerRound: att.cellsPerRound,
      cellCount: att.cellIds.length,
      mixtureSize: att.mixtureIds.length,
    },
    commitments: {
      attestationDigest: keccakString(`attestation/${e.key}/1`),
      referencePoolRoot: att.poolRoot,
      probePoolRoot: keccakString(`probes/${e.key}/1`),
      seedChainRoot: seedChain.root,
      canonicalArithmeticHash: CANONICAL_ARITHMETIC_HASH,
      normalizationImplHash: NORMALIZATION_IMPL_HASH,
      batteryCommit: keccakString("battery/backstop@1"),
    },
    evidence: { k: 6, n: 8, voidRateBreakerBps: 1500, producerBondWei: 10n ** 18n, producerClass: 0 },
    uri: `backstop://${e.provider}/${e.model}?label=${encodeURIComponent(e.label)}`,
  };
  await write(d.attestationRegistry, A.attestations, "issue", [params]);
  const id = await read(d.attestationRegistry, A.attestations, "versionCount");
  versionIds[e.key] = id;
  const eligible = await read(d.attestationRegistry, A.attestations, "settlementEligible", [id]);
  await write(d.coveragePool, A.pool, "setVersionEligible", [id, eligible]);
  console.log(`   v${id}  ${e.label.padEnd(38)} ${eligible ? c.green("settlement") : c.dim("measurement only")}`);
}

console.log(c.bold(`\n2. Underwriter capital`));
const DEPOSIT = 2_000_000n * 1_000_000n;
await write(d.asset, A.asset, "mint", [account.address, DEPOSIT * 3n]);
await write(d.asset, A.asset, "approve", [d.coveragePool, DEPOSIT]);
await write(d.coveragePool, A.pool, "deposit", [DEPOSIT]);
await write(d.coveragePool, A.pool, "setCaps", [
  1_000_000n * 1_000_000n,
  1_500_000n * 1_000_000n,
  1_500_000n * 1_000_000n,
  3000n,
]);
console.log(`   ${(DEPOSIT / 1_000_000n).toLocaleString()} bUSDC deposited, fully collateralised`);

console.log(c.bold(`\n3. Coverage`));
const passkey = new Uint8Array(32);
passkey.set(fromHex(keccakString("backstop|testnet|passkey")).slice(0, 32));
passkey[0] = 0x2f;
const pub = publicKeyFrom(passkey);
const credentialId = keccakString("backstop|testnet|credential");
await write(d.policyRegistry, A.policies, "enrollCredential", [credentialId, pub.x, pub.y]);

const policyIds = [];
let nonce = 1;
for (const notional of [250_000n, 120_000n, 75_000n, 40_000n]) {
  const block = await publicClient.getBlock();
  const terms = {
    chainId: BigInt(CHAIN_ID),
    verifyingContract: d.policyRegistry,
    attestationVersion: versionIds.primary,
    policyVersion: 1n,
    endpointId: keccakString(`endpoint/backstop/qwen3-1.7b`),
    buyer: account.address,
    notional: notional * 1_000_000n,
    term: 30n * 24n * 3600n,
    premiumRateBps: 180n,
    seasoningRounds: BigInt(att.seasoningRounds),
    nonce: BigInt(nonce++),
    expiry: block.timestamp + 3600n,
  };
  const assertion = signAssertion(
    passkey,
    fromHex(policyDigest(terms)),
    d.rpId,
    d.rpOrigin,
  );
  await write(d.asset, A.asset, "approve", [d.policyRegistry, terms.notional]);
  await write(d.policyRegistry, A.policies, "purchase", [
    terms,
    {
      authenticatorData: assertion.authenticatorData,
      clientDataJSON: assertion.clientDataJSON,
      r: assertion.r,
      s: assertion.s,
    },
    credentialId,
    { pDepartureBps: 420n, pDetectedBps: 9600n, falseAlarmBps: 500n, capitalChargeBps: 66n, poolMarginBps: 40n },
  ]);
  const id = await read(d.policyRegistry, A.policies, "policyCount");
  policyIds.push(id);
  console.log(`   policy ${id}  ${notional.toLocaleString()} bUSDC`);
}

console.log(c.bold(`\n4. The audit`));
const cellIds = att.cellIds;
const lawOf = (config, id) => normalise(laws.configs[config].cells[id].counts.map((v) => v + 0.5));
const attested = new Map(cellIds.map((id) => [id, lawOf("bf16", id)]));
const substitute = new Map(cellIds.map((id) => [id, lawOf("q4km", id)]));

const params = {
  poolRoot: att.poolRoot,
  m: att.m,
  tMax: att.tMax,
  lambdaRay: BigInt(att.lambdaRay),
  alphaRay: BigInt(att.alphaRay),
  mixtureIds: att.mixtureIds,
};
const cache = new PoolCache(pool, att.poolRoot, att.m, att.tMax);
const boundaryRay = new RunningProduct(params.alphaRay).boundaryRay;

const products = {
  primary: new RunningProduct(params.alphaRay),
  control: new RunningProduct(params.alphaRay),
};
const prngs = {
  primary: new Prng(keccakString("testnet|primary")),
  control: new Prng(keccakString("testnet|control")),
};
let crossedAt = null;

for (let round = 0; round < ROUNDS; round++) {
  const share = seedChain.shares[round];
  const beacon = keccakString(`beacon|${round}`);
  const seed = roundSeed(share, beacon);
  const selected = selectCells(seed, cellIds.length, att.cellsPerRound).map((i) => cellIds[i]);

  for (const [key, versionId] of [
    ["primary", versionIds.primary],
    ["control", versionIds.control],
  ]) {
    const obs = selected.map((cellId) => ({
      cellId,
      counts: draw(
        key === "primary" && round >= SWITCH_AT ? substitute.get(cellId) : attested.get(cellId),
        att.n,
        prngs[key],
      ),
    }));
    const verdict = evaluateRound(round, obs, pool, params, cache);
    products[key].update(round, verdict.eRoundRay);

    await write(d.auditRegistry, A.audits, "openRound", [versionId, round, share, beacon, att.cellsPerRound * att.n]);
    await write(d.auditRegistry, A.audits, "sealRound", [versionId, round, keccakString(`transcripts|${key}|${round}`), 0]);
    await write(d.auditRegistry, A.audits, "closeRound", [versionId, round, keccakString(`reveal|${key}|${round}`), verdict.eRoundRay]);
  }

  const frac = Number((products.primary.logRay * 10000n) / boundaryRay) / 10000;
  const line = `   round ${String(round).padStart(2)}  log M ${formatRay(products.primary.logRay, 3).padStart(9)}  ${(frac * 100).toFixed(0).padStart(4)}%`;
  console.log(products.primary.crossed ? c.red(line) : round >= SWITCH_AT ? c.yellow(line) : c.green(line));

  if (products.primary.crossed && crossedAt === null) {
    crossedAt = round;
    console.log(c.red(`\n   CROSSED at round ${round}\n`));
    break;
  }
}

if (crossedAt !== null) {
  console.log(c.bold(`\n5. Settlement`));
  const claimable = [];
  for (const id of policyIds) {
    if (await read(d.policyRegistry, A.policies, "claimable", [id, crossedAt])) claimable.push(id);
  }
  if (claimable.length > 0) {
    const leaves = claimable.map((id) =>
      hashLeaf(
        fromHex(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [id, account.address])),
      ),
    );
    const tree = new MerkleTree(leaves);
    await write(d.settlement, A.settlement, "publishClaimRoot", [versionIds.primary, crossedAt, tree.root]);
    console.log(`   claim root ${tree.root}`);
    console.log(c.dim(`   the challenge window is open; run the batch after it closes:`));
    console.log(c.dim(`     cast send ${d.settlement} "settleBatch(uint256,uint32,uint256[])" ${versionIds.primary} ${crossedAt} "[${claimable.join(",")}]"`));
  }
}

console.log(c.bold(`\nLive at ${d.rpOrigin}\n`));
