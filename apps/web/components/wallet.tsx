"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, custom, type Address, type WalletClient } from "viem";
import { monadTestnet } from "@backstop/sdk";

/**
 * One signer for the whole product.
 *
 * Two surfaces move money: the faucet that funds an evaluator, and the buy flow that enrols a
 * passkey, approves the premium and writes the policy. Both take their signer from here, so
 * whichever wallet layer is mounted is the wallet layer that signs. When Dynamic is
 * configured that is a Dynamic wallet, embedded or external; otherwise it is whatever the
 * browser injected. Nothing downstream knows the difference.
 */
export interface WalletHandle {
  client: WalletClient;
  account: Address;
}

export interface WalletConnector {
  /** What is supplying the signer, for display. */
  source: "dynamic" | "injected";
  /** The connected address, or null while nothing is connected. */
  address: Address | null;
  /**
   * Returns a signer, prompting the user to connect if none is available yet. Rejects when
   * the user closes the prompt or no wallet can be reached.
   */
  connect: () => Promise<WalletHandle>;
}

const WalletContext = createContext<WalletConnector | null>(null);

export function useWallet(): WalletConnector {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside a wallet provider");
  return ctx;
}

export function WalletProvider({
  value,
  children,
}: {
  value: WalletConnector;
  children: ReactNode;
}) {
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/**
 * The fallback path, used when no Dynamic environment is configured.
 *
 * It talks to an injected provider directly, which keeps the product drivable from a plain
 * browser wallet with no sponsor account in play.
 */
export function InjectedWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);

  const value = useMemo<WalletConnector>(
    () => ({
      source: "injected",
      address,
      async connect() {
        const eth = (globalThis as { ethereum?: unknown }).ethereum;
        if (!eth) throw new Error("No wallet found. Install a browser wallet to continue.");
        const client = createWalletClient({
          chain: monadTestnet,
          transport: custom(eth as never),
        });
        const [account] = await client.requestAddresses();
        if (!account) throw new Error("No account available.");
        await ensureChain(client);
        setAddress(account);
        return { client, account };
      },
    }),
    [address],
  );

  return <WalletProvider value={value}>{children}</WalletProvider>;
}

/**
 * A wallet connected to some other chain would sign a policy the contracts never see, so the
 * network is moved before anything is submitted rather than after it fails.
 */
export async function ensureChain(client: WalletClient): Promise<void> {
  const current = await client.getChainId();
  if (current === monadTestnet.id) return;
  try {
    await client.switchChain({ id: monadTestnet.id });
  } catch {
    await client.addChain({ chain: monadTestnet });
    await client.switchChain({ id: monadTestnet.id });
  }
}
