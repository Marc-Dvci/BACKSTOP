"use client";

import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import type { ReactNode } from "react";

/**
 * Dynamic supplies the wallet layer.
 *
 * Three primitives are used and each does real work in the product:
 *
 *   embedded wallet   a buyer reaches coverage with an email and never handles a seed phrase.
 *                     The passkey authorises the policy; the embedded wallet pays the premium
 *                     and holds the payout.
 *   server wallet     the issuer runs the audit cadence unattended: open, seal and close each
 *                     round, and publish the claim root at a crossing.
 *   agent wallet      an agent operator delegates evidence submission and claim redemption to a
 *                     scoped key, so an unattended producer can publish transcripts and redeem
 *                     without holding the buyer's account.
 *
 * The chain is Monad, so the environment must have Monad testnet enabled.
 */
export function Providers({ children }: { children: ReactNode }) {
  const environmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID;

  if (!environmentId) {
    // The app stays fully usable without the wallet layer: the index, every endpoint page,
    // the method pages and the docs are read-only views over chain state.
    return <>{children}</>;
  }

  return (
    <DynamicContextProvider
      settings={{
        environmentId,
        walletConnectors: [EthereumWalletConnectors],
        overrides: {
          evmNetworks: [
            {
              blockExplorerUrls: ["https://testnet.monadexplorer.com"],
              chainId: 10143,
              chainName: "Monad Testnet",
              iconUrls: [],
              name: "Monad Testnet",
              nativeCurrency: { decimals: 18, name: "Monad", symbol: "MON" },
              networkId: 10143,
              rpcUrls: ["https://testnet-rpc.monad.xyz"],
              vanityName: "Monad",
            },
          ],
        },
      }}
    >
      {children}
    </DynamicContextProvider>
  );
}
