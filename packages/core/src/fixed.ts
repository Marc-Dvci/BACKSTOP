/**
 * BSA-1: BACKSTOP Signed Arithmetic, version 1.
 *
 * The canonical arithmetic of the verdict path. Every quantity that can move money is
 * computed here, and the Solidity implementation in `contracts/src/lib/BSA1.sol` performs
 * the identical integer operations in the identical order.
 *
 * Representation
 *   Signed integers at scale RAY = 1e27. Published values are rounded to WAD = 1e18.
 *
 * Rounding
 *   One rounding mode throughout: truncation toward zero. BigInt `/` in JavaScript and
 *   `/` on `int256` in Solidity both truncate toward zero, so the two implementations
 *   agree on every intermediate. Arithmetic shifts are never applied to a negative value.
 *
 * Domain
 *   `ln` accepts x > 0. `exp` accepts |x| <= EXP_MAX. `pow` accepts x > 0 and any y whose
 *   product with ln(x) stays inside the `exp` domain. Callers outside the domain get a
 *   thrown error rather than a saturated value, and the verdict path never reaches one.
 */

export const RAY = 10n ** 27n;
export const WAD = 10n ** 18n;
export const RAY_PER_WAD = RAY / WAD;

/** ln(2) at RAY scale, truncated. 0.693147180559945309417232121 */
export const LN2 = 693147180559945309417232121n;

/** exp() domain bound. exp(88) fits inside int256 at RAY scale with headroom. */
export const EXP_MAX = 88n * RAY;

/**
 * Number of odd terms in the atanh series used by `ln`. Argument reduction against the
 * 16-entry table below puts z below 1/32, so z^19/19 is under 1e-29.
 */
const LN_TERMS = 10;

/** RAY / 16, exact. The step of the `ln` argument-reduction table. */
const LN_STEP = RAY / 16n;

/** ln(1 + j/16) at RAY scale, rounded half to even from a 60-digit computation. */
const LN_TABLE: readonly bigint[] = [
  0n,
  60624621816434842580606132n,
  117783035656383454538794109n,
  171850256926659222340098946n,
  223143551314209755766295090n,
  271933715483641758831669495n,
  318453731118534615810247214n,
  362905493689368453137824346n,
  405465108108164381978013115n,
  446287102628419511532590181n,
  485507815781700807801791077n,
  523248143764547836516807225n,
  559615787935422686270888501n,
  594707107746692789514343547n,
  628608659422374137744308206n,
  661398482245365008260235839n,
];

/** Number of terms in the Taylor series used by `exp`. |r| <= LN2/2, so r^25/25! < 1e-36. */
const EXP_TERMS = 25;

export class BsaDomainError extends Error {
  constructor(message: string) {
    super(`BSA-1 domain: ${message}`);
    this.name = "BsaDomainError";
  }
}

/** a * b / RAY, truncated toward zero. */
export function mul(a: bigint, b: bigint): bigint {
  return (a * b) / RAY;
}

/** a * RAY / b, truncated toward zero. */
export function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new BsaDomainError("division by zero");
  return (a * RAY) / b;
}

/** Integer position of the highest set bit of a positive value. */
function bitLength(x: bigint): number {
  if (x <= 0n) throw new BsaDomainError("bitLength of non-positive value");
  let n = 0;
  let v = x;
  // 64-bit strides first, then a linear finish. Deterministic and shift-free on negatives.
  while (v >= 1n << 64n) {
    v >>= 64n;
    n += 64;
  }
  while (v > 1n) {
    v >>= 1n;
    n += 1;
  }
  return n;
}

/**
 * Natural logarithm at RAY scale.
 *
 * x is written as m * 2^e with m in [RAY, 2*RAY), then reduced a second time against the
 * table above so that ln(m) = ln(d) + ln(m/d) with m/d within 1/16 of one. The remaining
 * factor is evaluated from ln(m/d) = 2 * atanh(z), z = (m - d) / (m + d), which puts z
 * below 1/32 and takes the odd-power series under RAY resolution in ten terms.
 */
export function ln(x: bigint): bigint {
  if (x <= 0n) throw new BsaDomainError("ln of non-positive value");

  // e = floor(log2(x / RAY))
  const e = BigInt(bitLength(x) - bitLength(RAY));
  let m: bigint;
  if (e >= 0n) {
    m = x / (1n << e);
  } else {
    m = x * (1n << -e);
  }
  // The bit-length estimate can land one step outside [RAY, 2*RAY). Correct it exactly.
  let ee = e;
  while (m >= 2n * RAY) {
    m /= 2n;
    ee += 1n;
  }
  while (m < RAY) {
    m *= 2n;
    ee -= 1n;
  }

  const j = (m - RAY) / LN_STEP;
  const d = RAY + j * LN_STEP;
  const z = ((m - d) * RAY) / (m + d);
  const z2 = (z * z) / RAY;

  let term = z; // z^1
  let sum = term;
  for (let k = 3; k <= 2 * LN_TERMS - 1; k += 2) {
    term = (term * z2) / RAY;
    if (term === 0n) break;
    sum += term / BigInt(k);
  }

  return 2n * sum + (LN_TABLE[Number(j)] as bigint) + ee * LN2;
}

/**
 * Exponential at RAY scale.
 *
 * x is split as k * ln(2) + r with |r| <= ln(2)/2, exp(r) comes from its Taylor series,
 * and the power of two is applied by exact multiplication or division.
 */
export function exp(x: bigint): bigint {
  if (x > EXP_MAX) throw new BsaDomainError("exp overflow");
  if (x < -EXP_MAX) return 0n;

  // k = nearest integer to x / LN2, computed without floating point.
  let k = x / LN2;
  const rem = x - k * LN2;
  if (rem * 2n > LN2) k += 1n;
  else if (rem * 2n < -LN2) k -= 1n;
  const r = x - k * LN2;

  let term = RAY;
  let sum = RAY;
  for (let n = 1; n <= EXP_TERMS; n++) {
    term = ((term * r) / RAY) / BigInt(n);
    if (term === 0n) break;
    sum += term;
  }

  if (k >= 0n) {
    if (k > 200n) throw new BsaDomainError("exp overflow");
    return sum * (1n << k);
  }
  const shift = -k;
  if (shift > 200n) return 0n;
  return sum / (1n << shift);
}

/** x^y at RAY scale, for x > 0. */
export function pow(x: bigint, y: bigint): bigint {
  if (x <= 0n) throw new BsaDomainError("pow of non-positive base");
  if (y === 0n) return RAY;
  return exp((y * ln(x)) / RAY);
}

/** Round a RAY value to WAD, truncating toward zero. */
export function toWad(x: bigint): bigint {
  return x / RAY_PER_WAD;
}

/** Widen a WAD value to RAY. Exact. */
export function fromWad(x: bigint): bigint {
  return x * RAY_PER_WAD;
}

/** Exact integer-to-RAY conversion. */
export function fromInt(x: bigint | number): bigint {
  return BigInt(x) * RAY;
}

/** Decimal rendering of a RAY value, for display and for test vector files. */
export function formatRay(x: bigint, decimals = 12): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const whole = a / RAY;
  const frac = (a % RAY).toString().padStart(27, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
