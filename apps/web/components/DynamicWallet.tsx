"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { isEthereumWallet } from "@dynamic-labs/ethereum";
import type { Address } from "viem";
import { WalletProvider, ensureChain, type WalletConnector, type WalletHandle } from "./wallet";

/**
 * Dynamic as the signer for every transaction the product sends.
 *
 * `getWalletClient` returns a viem wallet client whichever way the user arrived: an embedded
 * wallet created from an email or a passkey, or an external wallet they already had. That is
 * the point of routing the buy flow through here rather than through `window.ethereum` — an
 * embedded wallet injects nothing into the page, so a product that reaches for the injected
 * provider silently excludes every user who signed in with an email.
 */
export function DynamicWalletProvider({ children }: { children: ReactNode }) {
  const { primaryWallet, setShowAuthFlow } = useDynamicContext();

  // `connect` is called from an event handler and has to see the wallet the user picks after
  // it was called, so the current wallet is held in a ref rather than closed over.
  const walletRef = useRef(primaryWallet);
  useEffect(() => {
    walletRef.current = primaryWallet;
  }, [primaryWallet]);

  const address = (primaryWallet?.address as Address | undefined) ?? null;

  const value = useMemo<WalletConnector>(
    () => ({
      source: "dynamic",
      address,
      async connect(): Promise<WalletHandle> {
        if (!walletRef.current) {
          setShowAuthFlow(true);
          // The user is now in Dynamic's sign-in flow. Wait for it rather than failing, and
          // give up after two minutes so a closed modal does not leave a pending promise.
          const deadline = Date.now() + 120_000;
          while (!walletRef.current && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
          }
          if (!walletRef.current) throw new Error("No wallet connected.");
        }

        const wallet = walletRef.current;
        if (!isEthereumWallet(wallet)) {
          throw new Error("Connect an Ethereum wallet: BACKSTOP settles on Monad.");
        }
        const client = await wallet.getWalletClient();
        await ensureChain(client);
        return { client, account: wallet.address as Address };
      },
    }),
    [address, setShowAuthFlow],
  );

  return <WalletProvider value={value}>{children}</WalletProvider>;
}
