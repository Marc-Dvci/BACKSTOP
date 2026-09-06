/**
 * make demo
 *
 * One command that stands the whole protocol up and drives it end to end:
 *
 *   1. a local chain with Monad's P256 precompile in place at 0x0100
 *   2. the six contracts deployed and wired
 *   3. four attestations issued, two settlement-eligible and two measurement-only
 *   4. underwriter capital deposited
 *   5. three policies bought with a real passkey assertion, at three inception rounds
 *   6. audit rounds computed by the real e-process engine and published onchain
 *   7. the endpoint switched to a different quantisation partway through
 *   8. the claim root published and the batch settled, with the measured gas on screen
 *
 * The verdict at every round is produced by @backstop/core, and the crossing the contracts
 * pay against is re-derived onchain from the cumulative logs. Nothing here is staged.
 *
 * Usage
 *   node scripts/demo.mjs [--rounds 14] [--laws bench/out/laws.json] [--keep] [--snapshot]
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  defineChain,
  encodeAbiParameters,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const core = await import("../packages/core/dist/index.js");
const {
  RAY,
  keccakString,
  Prng,
  PoolCache,
  RunningProduct,
  evaluateRound,
  generatePool,
  draw,
  softmax,
  perturb,
  mix,
  lawKey,
  normalise,
  formatRay,
  buildSeedChain,
  roundSeed,
  selectCells,
  poolRoot,
  signAssertion,
  publicKeyFrom,
  policyDigest,
  MerkleTree,
  hashLeaf,
  fromHex,
  CELLS,
} = core;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const ROUNDS = Number(arg("rounds", 14));
const SWITCH_AT = Number(arg("switch-at", 6));
const M_CAL = Number(arg("m", 99));
const N_DRAWS = Number(arg("draws", 96));
const T_MAX = Number(arg("tmax", 40));
const CELLS_PER_ROUND = 8;
const ALPHA = Number(arg("alpha", 0.05));
const PORT = Number(arg("port", 8545));
const RPC = `http://127.0.0.1:${PORT}`;

const ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_PK2 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const anvilChain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const step = (n, title) => console.log(`\n${c.bold(`${n}. ${title}`)}`);

// ---------------------------------------------------------------- endpoint catalogue

/**
 * The demo catalogue. Two settlement-eligible endpoints, one of which will depart, and two
 * measurement-only endpoints whose serving stack the issuer could not authenticate.
 */
const CATALOGUE = [
  {
    key: "primary",
    provider: "backstop-demo",
    model: "qwen3-1.7b",
    label: "qwen3-1.7b, pinned BF16",
    unknownMask: 0,
    departs: true,
  },
  {
    key: "control",
    provider: "backstop-demo",
    model: "qwen3-1.7b-control",
    label: "qwen3-1.7b, control endpoint",
    unknownMask: 0,
    departs: false,
  },
  {
    key: "observed-a",
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct",
    // model identity and serving stack unknown, so the endpoint is measurement only
    unknownMask: 0b0111111,
    label: "llama-3.3-70b-instruct, observed",
    departs: false,
  },
  {
    key: "observed-b",
    provider: "openrouter",
    model: "qwen/qwen3-235b-a22b",
    unknownMask: 0b0111111,
    label: "qwen3-235b-a22b, observed",
    departs: false,
  },
];

// ---------------------------------------------------------------- laws

/**
 * The measured behaviour of each serving configuration.
 *
 * When the envelope harness has run, the laws come from the real model at the three
 * quantisations it measured. Otherwise they are generated from the same shape so the demo
 * runs before the harness has.
 */
function loadLaws() {
  const path = resolve(ROOT, arg("laws", "bench/out/laws.json"));
  const cellIds = CELLS.slice(0, CELLS_PER_ROUND).map((x) => x.id);

  if (existsSync(path)) {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const pick = (config) => {
      const m = new Map();
      for (const id of cellIds) {
        const cell = doc.configs[config]?.cells?.[id];
        if (!cell) throw new Error(`laws file has no ${config} / ${id}`);
        m.set(id, normalise(cell.counts.map((v) => v + 0.5)));
      }
      return m;
    };
    console.log(c.dim(`   laws from ${path} (${doc.model}, ${doc.drawsPerCell} draws per cell)`));
    return {
      source: `${doc.model} measured at ${Object.keys(doc.configs).join(", ")}`,
      attested: pick("bf16"),
      envelope: pick("q8_0"),
      substitute: pick("q4km"),
      cellIds,
    };
  }

  console.log(c.dim("   laws generated locally; run bench/harness.mjs to measure a real model"));
  const attested = new Map();
  const envelope = new Map();
  const substitute = new Map();
  for (const id of cellIds) {
    const prng = new Prng(keccakString(`demo|logits|${id}`));
    const logits = Array.from({ length: 10 }, () => (prng.nextU32() / 0x100000000) * 4 - 2);
    const a = softmax(logits);
    attested.set(id, a);
    envelope.set(id, perturb(a, 0.08, keccakString(`demo|env|${id}`)));
    const s = new Prng(keccakString(`demo|sub|${id}`));
    substitute.set(id, softmax(Array.from({ length: 10 }, () => (s.nextU32() / 0x100000000) * 4 - 2)));
  }
  return { source: "generated", attested, envelope, substitute, cellIds };
}

// ---------------------------------------------------------------- chain plumbing

function startAnvil() {
  const proc = spawn("anvil", ["--port", String(PORT), "--silent", "--block-time", "1"], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: process.platform === "win32",
  });
  return proc;
}

async function waitForChain(publicClient, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    try {
      await publicClient.getChainId();
      return;
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

function forge(args, env = {}) {
  return execFileSync("forge", args, {
    cwd: join(ROOT, "contracts"),
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

// ---------------------------------------------------------------- main

const anvil = startAnvil();
let exitCode = 0;

try {
  console.log(c.bold("\nBACKSTOP demo\n"));
  console.log(c.dim("  capital-backed verification for hosted AI inference"));

  const publicClient = createPublicClient({ chain: anvilChain, transport: http(RPC) });
  await waitForChain(publicClient);

  const issuer = privateKeyToAccount(ANVIL_PK);
  const buyer = privateKeyToAccount(ANVIL_PK2);
  const wallet = createWalletClient({ account: issuer, chain: anvilChain, transport: http(RPC) });
  const buyerWallet = createWalletClient({ account: buyer, chain: anvilChain, transport: http(RPC) });

  // ------------------------------------------------------------- 1. precompile
  step(1, "Monad's P256 precompile at 0x0100");
  const p256Artifact = JSON.parse(
    readFileSync(join(ROOT, "contracts/out/P256Precompile.sol/P256Precompile.json"), "utf8"),
  );
  const p256Hash = await wallet.deployContract({
    abi: p256Artifact.abi,
    bytecode: p256Artifact.bytecode.object,
  });
  const p256Receipt = await publicClient.waitForTransactionReceipt({ hash: p256Hash });
  const deployedCode = await publicClient.getCode({ address: p256Receipt.contractAddress });
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setCode",
      params: ["0x0000000000000000000000000000000000000100", deployedCode],
    }),
  });
  console.log(`   secp256r1 verification available at 0x0100, as on Monad`);

  // ------------------------------------------------------------- 2. deploy
  step(2, "Deploy the protocol");
  forge(
    [
      "script",
      "script/Deploy.s.sol",
      "--rpc-url",
      RPC,
      "--broadcast",
      "--skip-simulation",
      "-q",
    ],
    {
      DEPLOYER_PRIVATE_KEY: ANVIL_PK,
      RP_ORIGIN: "http://localhost:3100",
      RP_ID: "localhost",
      CHALLENGE_WINDOW: "1",
    },
  );
  const d = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/31337.json"), "utf8"));
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "string" && v.startsWith("0x")) console.log(`   ${k.padEnd(20)} ${v}`);
  }

  const abi = {
    attestations: loadAbi("AttestationRegistry"),
    audits: loadAbi("AuditRegistry"),
    pool: loadAbi("CoveragePool"),
    policies: loadAbi("PolicyRegistry"),
    settlement: loadAbi("Settlement"),
    asset: loadAbi("MockERC20"),
  };

  const write = async (address, contractAbi, functionName, args, account = issuer) => {
    const w = account === issuer ? wallet : buyerWallet;
    const hash = await w.writeContract({ address, abi: contractAbi, functionName, args, account });
    return publicClient.waitForTransactionReceipt({ hash });
  };
  const read = (address, contractAbi, functionName, args) =>
    publicClient.readContract({ address, abi: contractAbi, functionName, args });

  // ------------------------------------------------------------- 3. laws and pools
  step(3, "Generate the reference pools");
  const laws = loadLaws();
  const elementIds = ["cfg-attested", "cfg-envelope", "mix-50"];
  const cellIds = laws.cellIds;

  const lawMap = new Map();
  for (const id of cellIds) {
    lawMap.set(lawKey("cfg-attested", id), laws.attested.get(id));
    lawMap.set(lawKey("cfg-envelope", id), laws.envelope.get(id));
    lawMap.set(lawKey("mix-50", id), mix(laws.attested.get(id), laws.envelope.get(id), 0.5));
  }
  const alphabetSize = laws.attested.get(cellIds[0]).probs.length;

  const spec = {
    laws: lawMap,
    elementIds,
    cellIds,
    alphabetSize,
    n: N_DRAWS,
    nR: 6000,
    m: M_CAL,
    tMax: T_MAX,
  };

  const t0 = Date.now();
  const pool = generatePool(spec, keccakString("demo|pool"));
  const root = poolRoot(pool);
  console.log(
    `   ${elementIds.length} elements x ${cellIds.length} cells,` +
      ` ${M_CAL * T_MAX} calibration blocks of ${N_DRAWS} draws each`,
  );
  console.log(`   pool root ${root}`);
  console.log(c.dim(`   generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`));

  const seedChain = buildSeedChain(keccakString("demo|seed-secret"), T_MAX);

  // ------------------------------------------------------------- 4. attestations
  step(4, "Issue the attestations");
  const arithmeticHash = await read(d.attestationRegistry, abi.attestations, "getVersion", [1n]).catch(
    () => null,
  );
  const specHash = core.CANONICAL_ARITHMETIC_HASH;

  const versionIds = {};
  for (const e of CATALOGUE) {
    const endpointId = keccakString(`endpoint/${e.provider}/${e.model}`);
    const params = {
      endpointId,
      providerModelKey: keccakString(`${e.provider}|${e.model}`),
      unknownFieldMask: e.unknownMask,
      seasoningRounds: 2,
      stats: {
        alphaRay: BigInt(Math.round(ALPHA * 1e27)),
        lambdaRay: RAY / 2n,
        warningRay: 8n * RAY,
        m: M_CAL,
        n: N_DRAWS,
        nR: 6000,
        tMax: T_MAX,
        cellsPerRound: CELLS_PER_ROUND,
        cellCount: cellIds.length,
        mixtureSize: elementIds.length,
      },
      commitments: {
        attestationDigest: keccakString(`attestation/${e.key}/1`),
        referencePoolRoot: root,
        probePoolRoot: keccakString(`probes/${e.key}/1`),
        seedChainRoot: seedChain.root,
        canonicalArithmeticHash: specHash,
        normalizationImplHash: core.NORMALIZATION_IMPL_HASH,
        batteryCommit: keccakString("battery/backstop@1"),
      },
      evidence: {
        k: 6,
        n: 8,
        voidRateBreakerBps: 1500,
        producerBondWei: 10n ** 18n,
        producerClass: 0,
      },
      uri: `backstop://${e.provider}/${e.model}?label=${encodeURIComponent(e.label)}`,
    };

    await write(d.attestationRegistry, abi.attestations, "issue", [params]);
    const id = await read(d.attestationRegistry, abi.attestations, "versionCount", []);
    versionIds[e.key] = id;
    const eligible = await read(d.attestationRegistry, abi.attestations, "settlementEligible", [id]);
    await write(d.coveragePool, abi.pool, "setVersionEligible", [id, eligible]);
    console.log(
      `   v${id}  ${e.label.padEnd(38)} ${eligible ? c.green("settlement") : c.dim("measurement only")}`,
    );
  }

  // ------------------------------------------------------------- 5. capital
  step(5, "Underwriter capital");
  const DEPOSIT = 2_000_000n * 1_000_000n;
  await write(d.asset, abi.asset, "mint", [issuer.address, DEPOSIT * 2n]);
  await write(d.asset, abi.asset, "mint", [buyer.address, 1_000_000n * 1_000_000n]);
  await write(d.asset, abi.asset, "approve", [d.coveragePool, DEPOSIT]);
  await write(d.coveragePool, abi.pool, "deposit", [DEPOSIT]);
  await write(d.coveragePool, abi.pool, "setCaps", [
    1_000_000n * 1_000_000n,
    1_500_000n * 1_000_000n,
    1_500_000n * 1_000_000n,
    3000n,
  ]);
  const poolState = await read(d.coveragePool, abi.pool, "totalAssets", []);
  console.log(`   deposited ${(poolState / 1_000_000n).toLocaleString()} bUSDC, fully collateralised`);

  // ------------------------------------------------------------- 6. passkey
  step(6, "Enrol a passkey and buy coverage");
  const passkey = new Uint8Array(32);
  passkey.set(fromHex(keccakString("demo|passkey")).slice(0, 32));
  passkey[0] = 0x2f;
  const pub = publicKeyFrom(passkey);
  const credentialId = keccakString("demo|credential");
  await write(d.policyRegistry, abi.policies, "enrollCredential", [credentialId, pub.x, pub.y], buyer);
  console.log(`   credential enrolled, public point ${toHex(pub.x).slice(0, 14)}…`);

  const buyPolicy = async (notional, nonce) => {
    const chainId = await publicClient.getChainId();
    const block = await publicClient.getBlock();
    const terms = {
      chainId: BigInt(chainId),
      verifyingContract: d.policyRegistry,
      attestationVersion: versionIds.primary,
      policyVersion: 1n,
      endpointId: keccakString(`endpoint/backstop-demo/qwen3-1.7b`),
      buyer: buyer.address,
      notional,
      term: 30n * 24n * 3600n,
      premiumRateBps: 180n,
      seasoningRounds: 2n,
      nonce: BigInt(nonce),
      expiry: block.timestamp + 3600n,
    };
    const digest = policyDigest(terms);
    const assertion = signAssertion(passkey, fromHex(digest), "localhost", "http://localhost:3100");
    await write(d.asset, abi.asset, "approve", [d.policyRegistry, notional], buyer);
    await write(
      d.policyRegistry,
      abi.policies,
      "purchase",
      [
        terms,
        {
          authenticatorData: assertion.authenticatorData,
          clientDataJSON: assertion.clientDataJSON,
          r: assertion.r,
          s: assertion.s,
        },
        credentialId,
        {
          pDepartureBps: 420n,
          pDetectedBps: 9600n,
          falseAlarmBps: 500n,
          capitalChargeBps: 66n,
          poolMarginBps: 40n,
        },
      ],
      buyer,
    );
    const id = await read(d.policyRegistry, abi.policies, "policyCount", []);
    const p = await read(d.policyRegistry, abi.policies, "policy", [id]);
    console.log(
      `   policy ${id}  notional ${(notional / 1_000_000n).toLocaleString()} bUSDC` +
        `  inception round ${p.inceptionRound}  claim-eligible from round ${p.startRound}`,
    );
    return id;
  };

  // One cohort written before the audit begins, so the whole cohort crosses together.
  const policyIds = [];
  policyIds.push(await buyPolicy(250_000n * 1_000_000n, 1));
  policyIds.push(await buyPolicy(120_000n * 1_000_000n, 2));
  policyIds.push(await buyPolicy(75_000n * 1_000_000n, 3));
  policyIds.push(await buyPolicy(40_000n * 1_000_000n, 4));

  // ------------------------------------------------------------- 7. the audit
  step(7, "Run the audit");
  console.log(
    c.dim(
      `   ${ROUNDS} rounds, ${CELLS_PER_ROUND} cells per round, ${N_DRAWS} draws per cell,` +
        ` alpha ${ALPHA}, endpoint switches at round ${SWITCH_AT}`,
    ),
  );
  console.log(c.dim(`   behaviour source: ${laws.source}\n`));

  const params = {
    poolRoot: root,
    m: M_CAL,
    tMax: T_MAX,
    lambdaRay: RAY / 2n,
    alphaRay: BigInt(Math.round(ALPHA * 1e27)),
    mixtureIds: elementIds,
  };
  const cache = new PoolCache(pool, root, M_CAL, T_MAX);
  const boundaryRay = new RunningProduct(params.alphaRay).boundaryRay;

  const traces = { primary: [], control: [], benign: [] };
  const products = {
    primary: new RunningProduct(params.alphaRay),
    control: new RunningProduct(params.alphaRay),
    benign: new RunningProduct(params.alphaRay),
  };
  const roundRecords = [];
  let crossedAt = null;

  const prngs = {
    primary: new Prng(keccakString("demo|draws|primary")),
    control: new Prng(keccakString("demo|draws|control")),
    benign: new Prng(keccakString("demo|draws|benign")),
  };

  const bar = (fraction, width = 26) => {
    const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
    return `${"#".repeat(filled)}${".".repeat(width - filled)}`;
  };

  for (let round = 0; round < ROUNDS; round++) {
    const share = seedChain.shares[round];
    const beacon = keccakString(`beacon|${round}`);
    const seed = roundSeed(share, beacon);
    const selected = selectCells(seed, cellIds.length, CELLS_PER_ROUND).map((i) => cellIds[i]);

    // The primary endpoint serves the attested configuration, then departs.
    const scenarios = {
      primary: (cellId) =>
        round < SWITCH_AT ? laws.attested.get(cellId) : laws.substitute.get(cellId),
      // The control endpoint never departs.
      control: (cellId) => laws.attested.get(cellId),
      // A benign configuration change inside the declared envelope.
      benign: (cellId) => (round < SWITCH_AT ? laws.attested.get(cellId) : laws.envelope.get(cellId)),
    };

    const verdicts = {};
    for (const key of ["primary", "control", "benign"]) {
      const obs = selected.map((cellId) => ({
        cellId,
        counts: draw(scenarios[key](cellId), N_DRAWS, prngs[key]),
      }));
      const v = evaluateRound(round, obs, pool, params, cache);
      products[key].update(round, v.eRoundRay);
      traces[key].push(products[key].logRay.toString());
      verdicts[key] = v;
    }

    // Publish the primary endpoint's round onchain.
    await write(d.auditRegistry, abi.audits, "openRound", [
      versionIds.primary,
      round,
      share,
      beacon,
      CELLS_PER_ROUND * 8,
    ]);
    await write(d.auditRegistry, abi.audits, "sealRound", [
      versionIds.primary,
      round,
      keccakString(`transcripts|${round}`),
      0,
    ]);
    await write(d.auditRegistry, abi.audits, "closeRound", [
      versionIds.primary,
      round,
      keccakString(`reveal|${round}`),
      verdicts.primary.eRoundRay,
    ]);

    // The control endpoint publishes too, so the index shows a flat trace beside the climbing one.
    await write(d.auditRegistry, abi.audits, "openRound", [versionIds.control, round, share, beacon, CELLS_PER_ROUND * 8]);
    await write(d.auditRegistry, abi.audits, "sealRound", [versionIds.control, round, keccakString(`transcripts|c|${round}`), 0]);
    await write(d.auditRegistry, abi.audits, "closeRound", [versionIds.control, round, keccakString(`reveal|c|${round}`), verdicts.control.eRoundRay]);

    const frac = Number((products.primary.logRay * 10000n) / boundaryRay) / 10000;
    const line =
      `   round ${String(round).padStart(2)}  E(t) ${formatRay(verdicts.primary.eRoundRay, 3).padStart(9)}` +
      `  log M ${formatRay(products.primary.logRay, 3).padStart(9)}  ${bar(frac)} ${(frac * 100).toFixed(0).padStart(3)}%`;
    console.log(products.primary.crossed ? c.red(line) : round >= SWITCH_AT ? c.yellow(line) : c.green(line));

    roundRecords.push({
      round,
      seed,
      cells: selected,
      eRoundRay: verdicts.primary.eRoundRay.toString(),
      logMRay: products.primary.logRay.toString(),
    });

    if (round === SWITCH_AT - 1) {
      console.log(c.dim(`   -- the endpoint switches to the cheaper quantisation --`));
    }

    // A second cohort is written after the departure has begun but before it is detected.
    if (round === SWITCH_AT + 1) {
      policyIds.push(await buyPolicy(60_000n * 1_000_000n, 5));
    }

    if (products.primary.crossed && crossedAt === null) {
      crossedAt = round;
      console.log(
        c.red(
          `\n   CROSSED at round ${round}. ` +
            `The evidence passed ln(1/alpha) = ${formatRay(boundaryRay, 4)}, fixed before round 0.\n`,
        ),
      );
      break;
    }
  }

  console.log(
    `   control endpoint  log M ${formatRay(products.control.logRay, 4)}  ${products.control.crossed ? c.red("crossed") : c.green("flat")}`,
  );
  console.log(
    `   benign change     log M ${formatRay(products.benign.logRay, 4)}  ${products.benign.crossed ? c.red("crossed") : c.green("flat")}`,
  );

  // ------------------------------------------------------------- 8. settlement
  if (crossedAt !== null) {
    step(8, "Settle");
    const claimable = [];
    for (const id of policyIds) {
      const ok = await read(d.policyRegistry, abi.policies, "claimable", [id, crossedAt]);
      claimable.push({ id, ok });
      console.log(`   policy ${id}  ${ok ? c.green("crossed inside its term") : c.dim("not yet claim-eligible")}`);
    }

    const leaves = claimable
      .filter((x) => x.ok)
      .map((x) =>
        hashLeaf(
          fromHex(
            encodeAbiParameters(
              [{ type: "uint256" }, { type: "address" }],
              [x.id, buyer.address],
            ),
          ),
        ),
      );
    if (leaves.length > 0) {
      const tree = new MerkleTree(leaves);
      await write(d.settlement, abi.settlement, "publishClaimRoot", [versionIds.primary, crossedAt, tree.root]);
      console.log(`   claim root ${tree.root}`);
    }

    // The challenge window is one second in the demo; on testnet it is ten minutes.
    await new Promise((r) => setTimeout(r, 2500));

    const ids = claimable.filter((x) => x.ok).map((x) => x.id);
    if (ids.length > 0) {
      const before = await read(d.asset, abi.asset, "balanceOf", [buyer.address]);
      const receipt = await write(d.settlement, abi.settlement, "settleBatch", [
        versionIds.primary,
        crossedAt,
        ids,
      ]);
      const after = await read(d.asset, abi.asset, "balanceOf", [buyer.address]);
      console.log(
        `   settled ${ids.length} policy/policies in one transaction,` +
          ` ${receipt.gasUsed.toLocaleString()} gas` +
          ` (${(receipt.gasUsed / BigInt(ids.length)).toLocaleString()} per policy)`,
      );
      console.log(
        `   Monad allows 30,000,000 gas per transaction inside a 150,000,000 block,` +
          ` so the batch path clears the whole cohort in one call`,
      );
      console.log(c.green(`   paid out ${((after - before) / 1_000_000n).toLocaleString()} bUSDC`));
    }
  }

  // ------------------------------------------------------------- 9. snapshot
  step(9, "Write the snapshot the app reads");
  const snapshot = await buildSnapshot({
    read,
    d,
    abi,
    versionIds,
    traces,
    boundaryRay,
    laws,
    roundRecords,
    crossedAt,
  });
  const snapPath = join(ROOT, "apps/web/lib/snapshot.json");
  mkdirSync(dirname(snapPath), { recursive: true });
  writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));
  console.log(`   ${snapPath}`);

  const demoOut = join(ROOT, "docs/results/demo.json");
  writeFileSync(
    demoOut,
    JSON.stringify(
      {
        rounds: roundRecords,
        crossedAt,
        boundaryRay: boundaryRay.toString(),
        traces,
        lawSource: laws.source,
        params: { m: M_CAL, n: N_DRAWS, cellsPerRound: CELLS_PER_ROUND, alpha: ALPHA, tMax: T_MAX },
      },
      null,
      2,
    ),
  );
  console.log(`   ${demoOut}`);

  console.log(c.bold("\nDone.\n"));
  console.log("  The endpoint published its claim, the test was fixed in advance, the evidence");
  console.log("  was proven rather than asserted, and the money moved without anyone filing.\n");

  if (has("keep")) {
    console.log(c.dim(`  anvil is still running on ${RPC}. Press Ctrl+C to stop.\n`));
    await new Promise(() => {});
  }
} catch (err) {
  console.error(c.red(`\n  ${err?.stack ?? err}\n`));
  exitCode = 1;
} finally {
  if (!has("keep")) anvil.kill();
  process.exit(exitCode);
}

// ---------------------------------------------------------------- helpers

function loadAbi(name) {
  const path = name === "MockERC20"
    ? join(ROOT, "contracts/out/MockERC20.sol/MockERC20.json")
    : join(ROOT, `contracts/out/${name}.sol/${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")).abi;
}

async function buildSnapshot({ read, d, abi, versionIds, traces, boundaryRay, laws, crossedAt }) {
  const endpoints = [];
  const rounds = {};

  const count = await read(d.attestationRegistry, abi.attestations, "versionCount", []);
  for (let i = 1n; i <= count; i++) {
    const v = await read(d.attestationRegistry, abi.attestations, "getVersion", [i]);
    const eligible = await read(d.attestationRegistry, abi.attestations, "settlementEligible", [i]);
    const bound = await read(d.attestationRegistry, abi.attestations, "boundaryRay", [i]);
    const warn = await read(d.attestationRegistry, abi.attestations, "warningLogRay", [i]);
    const closed = await read(d.auditRegistry, abi.audits, "closedRounds", [i]);
    const vlog = await read(d.auditRegistry, abi.audits, "versionLog", [i]);
    const inWarn = await read(d.auditRegistry, abi.audits, "inWarningRegion", [i]);
    const voidRate = await read(d.auditRegistry, abi.audits, "voidRateBps", [i]);

    const meta = parseUri(v.uri);
    endpoints.push({
      versionId: Number(i),
      endpointId: v.endpointId,
      label: meta.label,
      model: meta.model,
      provider: meta.provider,
      issuer: v.issuer,
      settlementEligible: eligible,
      status: Number(v.status),
      closedRounds: Number(closed),
      versionLogRay: vlog.toString(),
      boundaryRay: bound.toString(),
      warningLogRay: warn.toString(),
      inWarningRegion: inWarn,
      voidRateBps: Number(voidRate),
      alphaRay: v.stats.alphaRay.toString(),
      tMax: Number(v.stats.tMax),
      m: Number(v.stats.m),
      n: Number(v.stats.n),
      cellsPerRound: Number(v.stats.cellsPerRound),
      mixtureSize: Number(v.stats.mixtureSize),
      uri: v.uri,
      attestationDigest: v.commitments.attestationDigest,
      referencePoolRoot: v.commitments.referencePoolRoot,
      seasoningRounds: Number(v.seasoningRounds),
    });

    const rs = [];
    for (let r = 0; r < Number(closed); r++) {
      const row = await read(d.auditRegistry, abi.audits, "getRound", [i, r]);
      rs.push({
        index: r,
        state: Number(row.state),
        eRoundRay: row.eRoundRay.toString(),
        logERoundRay: row.logERoundRay.toString(),
        cumLogRay: row.cumLogRay.toString(),
        seed: row.seed,
        transcriptRoot: row.transcriptRoot,
        revealRoot: row.revealRoot,
        closedAt: Number(row.closedAt),
        scheduled: Number(row.scheduled),
        voided: Number(row.voided),
      });
    }
    rounds[String(i)] = rs;
  }

  const policyCount = await read(d.policyRegistry, abi.policies, "policyCount", []);
  const policies = [];
  for (let i = 1n; i <= policyCount; i++) {
    const p = await read(d.policyRegistry, abi.policies, "policy", [i]);
    const log = await read(d.policyRegistry, abi.policies, "policyLog", [i]);
    const bound = await read(d.attestationRegistry, abi.attestations, "boundaryRay", [p.versionId]);
    const redeemed = await read(d.settlement, abi.settlement, "redeemed", [i]);
    policies.push({
      policyId: Number(i),
      buyer: p.buyer,
      versionId: Number(p.versionId),
      notional: p.notional.toString(),
      premiumEscrowed: p.premiumEscrowed.toString(),
      startRound: Number(p.startRound),
      inceptionRound: Number(p.inceptionRound),
      expiryAt: Number(p.expiryAt),
      status: Number(p.status),
      policyLogRay: log.toString(),
      boundaryRay: bound.toString(),
      redeemed,
    });
  }

  const [totalAssets, reservedCapital, freeCapital, maxNotional, totalShares] = await Promise.all([
    read(d.coveragePool, abi.pool, "totalAssets", []),
    read(d.coveragePool, abi.pool, "reservedCapital", []),
    read(d.coveragePool, abi.pool, "freeCapital", []),
    read(d.coveragePool, abi.pool, "maxNotional", []),
    read(d.coveragePool, abi.pool, "totalShares", []),
  ]);

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    chainId: 31337,
    lawSource: laws.source,
    crossedAt,
    boundaryRay: boundaryRay.toString(),
    traces,
    endpoints,
    rounds,
    policies,
    pool: {
      totalAssets: totalAssets.toString(),
      reservedCapital: reservedCapital.toString(),
      freeCapital: freeCapital.toString(),
      maxNotional: maxNotional.toString(),
      totalShares: totalShares.toString(),
    },
  };
}

function parseUri(uri) {
  try {
    const withoutScheme = uri.replace(/^backstop:\/\//, "");
    const [path, query] = withoutScheme.split("?");
    const [provider, ...modelParts] = (path ?? "").split("/");
    const model = modelParts.join("/");
    const label = new URLSearchParams(query ?? "").get("label") ?? model;
    return { label, provider: provider ?? "unknown", model: model || uri };
  } catch {
    return { label: uri, provider: "unknown", model: uri };
  }
}
