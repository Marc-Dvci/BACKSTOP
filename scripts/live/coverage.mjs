/**
 * Coverage on a live version, and its settlement once the version crosses.
 *
 *   buy     write policies on the version, each authorised by a WebAuthn assertion over the
 *           domain-bound policy digest and verified on chain through the P256 precompile
 *   settle  once a policy's own process has crossed and the round is past its challenge
 *           window, publish the claim root and settle the cohort in one transaction
 *
 * The buyer's passkey here is a software authenticator with a fixed key, so the script can run
 * unattended; the ceremony it signs is the one a browser passkey signs on /buy.
 *
 * Usage
 *   node --env-file=.env scripts/live/coverage.mjs buy    --key switched [--notionals 60000,30000,15000]
 *   node --env-file=.env scripts/live/coverage.mjs settle --key switched
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters } from "viem";
import { ROOT, arg, core, abis, deployment, publicClient, walletFor, requireEnv, send, read } from "./common.mjs";

const { keccakString, signAssertion, publicKeyFrom, policyDigest, fromHex, MerkleTree, hashLeaf } = core;
const A = abis;

const mode = process.argv[2];
const KEY = arg("key", "switched");
const STATE = join(ROOT, "attestations", "live.json");
const state = JSON.parse(readFileSync(STATE, "utf8"));
const entry = state.versions?.[KEY];
if (!entry) throw new Error(`${KEY} has not been issued`);
const versionId = BigInt(entry.versionId);
const att = JSON.parse(readFileSync(join(ROOT, entry.attestation), "utf8"));

if (mode === "buy") {
  const buyer = walletFor(requireEnv("DEPLOYER_PRIVATE_KEY"));
  const passkey = new Uint8Array(32);
  passkey.set(fromHex(keccakString("backstop|testnet|passkey")).slice(0, 32));
  passkey[0] = 0x2f;
  const credentialId = keccakString("backstop|testnet|credential");
  const pub = publicKeyFrom(passkey);
  const [, , enrolled] = await read(deployment.policyRegistry, A.policyRegistryAbi, "credentials", [
    buyer.account.address,
    credentialId,
  ]);
  if (!enrolled) {
    await send(buyer.wallet, buyer.account, deployment.policyRegistry, A.policyRegistryAbi, "enrollCredential", [credentialId, pub.x, pub.y]);
  }

  const notionals = String(arg("notionals", "60000,30000,15000")).split(",").map((v) => BigInt(v) * 1_000_000n);
  const total = notionals.reduce((a, b) => a + b, 0n);
  await send(buyer.wallet, buyer.account, deployment.asset, A.erc20Abi, "mint", [buyer.account.address, total]);
  await send(buyer.wallet, buyer.account, deployment.asset, A.erc20Abi, "approve", [deployment.policyRegistry, total]);

  entry.policies ??= [];
  let nonce = BigInt(Date.now());
  for (const notional of notionals) {
    const block = await publicClient.getBlock();
    const terms = {
      chainId: 10143n,
      verifyingContract: deployment.policyRegistry,
      attestationVersion: versionId,
      policyVersion: 1n,
      endpointId: att.endpointId,
      buyer: buyer.account.address,
      notional,
      term: 30n * 24n * 3600n,
      premiumRateBps: 180n,
      seasoningRounds: BigInt(att.seasoningRounds),
      nonce: nonce++,
      expiry: block.timestamp + 3600n,
    };
    const assertion = signAssertion(passkey, fromHex(policyDigest(terms)), deployment.rpId, deployment.rpOrigin);
    await send(buyer.wallet, buyer.account, deployment.policyRegistry, A.policyRegistryAbi, "purchase", [
      terms,
      { authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON, r: assertion.r, s: assertion.s },
      credentialId,
      { pDepartureBps: 420n, pDetectedBps: 9600n, falseAlarmBps: 500n, capitalChargeBps: 66n, poolMarginBps: 40n },
    ]);
    const id = await read(deployment.policyRegistry, A.policyRegistryAbi, "policyCount");
    const p = await read(deployment.policyRegistry, A.policyRegistryAbi, "policy", [id]);
    entry.policies.push(Number(id));
    console.log(`  policy ${id}  ${(notional / 1_000_000n).toLocaleString()} bUSDC  from round ${p.startRound}`);
  }
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  process.exit(0);
}

if (mode === "settle") {
  const issuer = walletFor(requireEnv("LIVE_ISSUER_KEY"));
  const ids = (entry.policies ?? []).map(BigInt);
  const closed = Number(await read(deployment.auditRegistry, A.auditRegistryAbi, "closedRounds", [versionId]));
  // The first round at which each policy's own process crossed.
  const crossing = new Map();
  for (const id of ids) {
    for (let r = 0; r < closed; r++) {
      if (await read(deployment.policyRegistry, A.policyRegistryAbi, "claimable", [id, r])) {
        crossing.set(id, r);
        break;
      }
    }
  }
  if (crossing.size === 0) {
    console.log("  no policy on this version has crossed");
    process.exit(3);
  }
  const byRound = new Map();
  for (const [id, r] of crossing) byRound.set(r, [...(byRound.get(r) ?? []), id]);

  for (const [round, cohort] of byRound) {
    const root = await read(deployment.settlement, A.settlementAbi, "claimRoot", [versionId, round]);
    if (/^0x0+$/.test(root)) {
      const leaves = [];
      for (const id of cohort) {
        const p = await read(deployment.policyRegistry, A.policyRegistryAbi, "policy", [id]);
        leaves.push(hashLeaf(fromHex(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [id, p.buyer]))));
      }
      const tree = new MerkleTree(leaves);
      await send(issuer.wallet, issuer.account, deployment.settlement, A.settlementAbi, "publishClaimRoot", [versionId, round, tree.root]);
      console.log(`  claim root for round ${round} published: ${cohort.length} policies`);
    }
    if (!(await read(deployment.settlement, A.settlementAbi, "isFinal", [versionId, round]))) {
      console.log(`  round ${round} is inside its challenge window; settle after it closes`);
      continue;
    }
    const receipt = await send(issuer.wallet, issuer.account, deployment.settlement, A.settlementAbi, "settleBatch", [versionId, round, cohort]);
    console.log(`  settled ${cohort.length} policies at round ${round} in one transaction, ${receipt.gasUsed} gas`);
    entry.settled = { round, policies: cohort.map(Number), tx: receipt.transactionHash };
    writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  }
  process.exit(0);
}

console.error("usage: coverage.mjs buy|settle --key <key>");
process.exit(2);
