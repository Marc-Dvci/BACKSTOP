"use client";

import dynamic from "next/dynamic";

/**
 * The wallet control, loaded on the client only.
 *
 * Dynamic reaches for browser APIs during initialisation, so it is kept out of the server
 * render. When no environment is configured the bar shows the network badge alone and every
 * read-only page still works.
 */
const WalletBar = dynamic(() => import("./WalletBar").then((m) => m.WalletBar), {
  ssr: false,
  loading: () => <span className="badge badge-cyan">Monad testnet</span>,
});

export function TopBarWallet({ enabled }: { enabled: boolean }) {
  if (!enabled) return <span className="badge badge-cyan">Monad testnet</span>;
  return <WalletBar />;
}
