"use client";

import { DynamicWidget, useDynamicContext } from "@dynamic-labs/sdk-react-core";

/**
 * The wallet control in the top bar.
 *
 * Rendered only when the Dynamic environment is configured. `DynamicWidget` is the whole
 * login and wallet surface: email or social sign-in into an embedded wallet, or an external
 * wallet, both landing on Monad testnet.
 */
export function WalletBar() {
  const { sdkHasLoaded } = useDynamicContext();
  if (!sdkHasLoaded) {
    return <span className="badge badge-measurement">wallet loading</span>;
  }
  return <DynamicWidget innerButtonComponent={<span>Connect</span>} />;
}
