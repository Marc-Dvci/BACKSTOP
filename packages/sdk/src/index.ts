/**
 * @backstop/sdk
 *
 * Buy coverage, register as a contributor, submit attested evidence, redeem a claim.
 *
 * ```ts
 * import { BackstopClient, monadTestnet, deployment } from "@backstop/sdk";
 *
 * const backstop = new BackstopClient({ deployment, chain: monadTestnet, account });
 * const status = await backstop.endpointStatus(1n);
 * console.log(status.progressBps / 100, "per cent of the way to the boundary");
 *
 * const digest = await backstop.policyDigest(terms);
 * const assertion = await assert({ rpId: deployment.rpId, challenge: digest });
 * await backstop.purchase({ terms, assertion, credentialId, quoteInputs });
 * ```
 */

export * from "./abi.js";
export * from "./chains.js";
export * from "./client.js";
export * from "./quote.js";
export * from "./passkey.js";
export * from "./deployment.js";
export * from "./prf.js";
