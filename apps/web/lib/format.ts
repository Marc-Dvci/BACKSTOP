/** Display helpers. Numbers are the product here, so formatting is one place. */

export const RAY = 10n ** 27n;

export function formatRay(x: bigint, decimals = 4): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const whole = a / RAY;
  const frac = (a % RAY).toString().padStart(27, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** exp of a RAY-scale log, as a float, for display only. */
export function expRay(logRay: bigint): number {
  return Math.exp(Number(logRay) / 1e27);
}

export function usdc(v: bigint, decimals = 0): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").slice(0, decimals);
  const s = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimals > 0 ? `${s}.${frac}` : s;
}

export function pct(x: number, decimals = 1): string {
  return `${(x * 100).toFixed(decimals)}%`;
}

export function short(hex: string, head = 6, tail = 4): string {
  if (hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head + 2)}…${hex.slice(-tail)}`;
}

export function ago(unixSeconds: number): string {
  if (!unixSeconds) return "-";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function untilLabel(unixSeconds: number): string {
  const s = unixSeconds - Math.floor(Date.now() / 1000);
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.floor(s / 60)}m left`;
  if (s < 86400) return `${Math.floor(s / 3600)}h left`;
  return `${Math.floor(s / 86400)}d left`;
}

export const POLICY_STATUS = ["none", "active", "expired", "settled"] as const;
export const VERSION_STATUS = ["none", "active", "retired", "suspended"] as const;
