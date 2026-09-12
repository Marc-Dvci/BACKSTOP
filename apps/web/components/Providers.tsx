"use client";

import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import type { ReactNode } from "react";
import { DynamicWalletProvider } from "./DynamicWallet";
import { InjectedWalletProvider } from "./wallet";

/**
 * Dynamic supplies the wallet layer.
 *
 * Three primitives, each doing real work rather than sitting behind a login button:
 *
 *   embedded wallet  a buyer reaches coverage with an email and never handles a seed phrase.
 *                    The passkey authorises the policy and the embedded wallet pays the
 *                    premium and receives the payout, so the two credentials do different
 *                    jobs: one proves intent, the other moves money.
 *   server wallet    the issuer runs the audit cadence unattended, opening, sealing and
 *                    closing each round and publishing the claim root at a crossing.
 *   agent wallet     an agent operator delegates evidence submission and claim redemption to
 *                    a scoped key, so an unattended producer publishes transcripts and
 *                    redeems without ever holding the buyer's account.
 *
 * The chain is Monad testnet, declared here so the wallet lands on the right network without
 * the user switching by hand.
 */
export const MONAD_TESTNET_NETWORK = {
  blockExplorerUrls: ["https://testnet.monadexplorer.com"],
  chainId: 10143,
  chainName: "Monad Testnet",
  iconUrls: [],
  name: "Monad Testnet",
  nativeCurrency: { decimals: 18, name: "Monad", symbol: "MON" },
  networkId: 10143,
  rpcUrls: ["https://testnet-rpc.monad.xyz"],
  vanityName: "Monad",
};

export function Providers({ children }: { children: ReactNode }) {
  const environmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID;

  // Without an environment id the SDK cannot initialise. The product stays drivable on an
  // injected wallet, and every read-only surface is unaffected: the index, each endpoint, the
  // method pages, the docs and the claim vault.
  if (!environmentId) return <InjectedWalletProvider>{children}</InjectedWalletProvider>;

  return (
    <DynamicContextProvider
      settings={{
        environmentId,
        walletConnectors: [EthereumWalletConnectors],
        overrides: { evmNetworks: [MONAD_TESTNET_NETWORK] },
      }}
    >
      <DynamicWalletProvider>{children}</DynamicWalletProvider>
    </DynamicContextProvider>
  );
}
