"use client";

import { useState } from "react";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { erc20Abi, monadTestnet, type Deployment } from "@backstop/sdk";
import { useWallet } from "@/components/wallet";

/**
 * Settlement-asset faucet.
 *
 * The testnet asset is freely mintable, so anyone evaluating the product can fund themselves
 * and drive the whole flow: deposit as an underwriter, or buy coverage as a buyer. Gas comes
 * from the Monad faucet, which is the one thing this page cannot hand out.
 */
export function Faucet({ deployment }: { deployment: Deployment }) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [balance, setBalance] = useState<string | null>(null);
  const [tx, setTx] = useState<Hex | null>(null);

  const publicClient = createPublicClient({ chain: monadTestnet, transport: http() });
  const wallet = useWallet();

  async function mint() {
    try {
      setState("working");
      setMessage("Connecting…");

      // Connecting also moves the wallet onto Monad testnet, so the mint cannot land on
      // whatever network the wallet happened to be pointing at.
      const { client, account } = await wallet.connect();

      setMessage("Minting 1,000,000 bUSDC…");
      const hash = await client.writeContract({
        address: deployment.asset as Address,
        abi: erc20Abi,
        functionName: "mint",
        args: [account, 1_000_000n * 1_000_000n],
        account,
        chain: monadTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setTx(hash);

      const held = (await publicClient.readContract({
        address: deployment.asset as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;
      setBalance((held / 1_000_000n).toLocaleString());

      setState("done");
      setMessage("Funded.");
    } catch (err) {
      setState("error");
      setMessage((err as Error).message);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn btn-primary" onClick={mint} disabled={state === "working"}>
          Mint 1,000,000 bUSDC
        </button>
        <a className="btn" href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">
          Get testnet MON for gas
        </a>
      </div>
      {message && (
        <div
          className="hint"
          style={{ marginTop: 12, color: state === "error" ? "var(--alarm)" : "var(--text-dim)" }}
        >
          {message}
          {balance && ` Balance: ${balance} bUSDC.`}
        </div>
      )}
      {tx && (
        <a
          className="hint"
          style={{ display: "block", marginTop: 6, color: "var(--cyan)" }}
          href={`https://testnet.monadexplorer.com/tx/${tx}`}
          target="_blank"
          rel="noreferrer"
        >
          view the transaction
        </a>
      )}
    </div>
  );
}
