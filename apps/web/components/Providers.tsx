"use client";

import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import type { ReactNode } from "react";
import { DynamicWalletProvider } from "./DynamicWallet";
import { InjectedWalletProvider } from "./wallet";

/**
 * Dynamic supplies the wallet layer.
 *
 * It is the signer for every transaction the app sends, not a login button:
 *
 *   embedded wallet  a buyer reaches coverage with an email and never handles a seed phrase.
 *                    The passkey authorises the policy and the embedded wallet pays the
 *                    premium and receives the payout, so the two credentials do different
 *                    jobs: one proves intent, the other moves money.
 *   external wallet  a buyer who already has a wallet connects it through the same flow, and
 *                    the app sends the same transactions through it.
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
