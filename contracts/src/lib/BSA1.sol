// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title BSA-1: BACKSTOP Signed Arithmetic, version 1
 * @notice The canonical arithmetic of the verdict path.
 *
 * The statistic takes logarithms and the calibrator raises a p-value to a fractional power,
 * so conforming floating-point implementations can disagree in the last bits. Near the
 * boundary that is the difference between a claim and no claim. BSA-1 fixes one integer
 * representation, one rounding mode and one algorithm for each transcendental, so this
 * library and `packages/core/src/fixed.ts` produce the same integer from the same input.
 *
 * Representation  signed int256 at scale RAY = 1e27
 * Rounding        truncation toward zero, which is what Solidity `/` on int256 and
 *                 JavaScript BigInt `/` both do
 * Shifts          never applied to a negative value, so the two languages cannot diverge
 *                 on arithmetic versus logical shift semantics
 *
 * Measured error against a 60-digit reference table (`vectors/bsa1-reference.json`):
 *   ln   1e-25 absolute
 *   exp  4e-27 absolute plus 1e-25 relative
 *   pow  1e-24 absolute
 *
 * The spec string is hashed into every attestation, so a change on either side breaks the
 * attestation reference rather than changing a verdict underneath a live policy.
 */
library BSA1 {
    int256 internal constant RAY = 1e27;
    int256 internal constant WAD = 1e18;

    /// @dev ln(2) at RAY scale.
    int256 internal constant LN2 = 693147180559945309417232121;

    /// @dev RAY / 16, the step of the ln argument-reduction table.
    int256 internal constant LN_STEP = 62500000000000000000000000;

    /// @dev exp() domain bound.
    int256 internal constant EXP_MAX = 88 * RAY;

    uint256 internal constant LN_TERMS = 10;
    uint256 internal constant EXP_TERMS = 25;

    /// @dev The canonical arithmetic spec, hashed into every attestation.
    string internal constant SPEC =
        "BSA-1|scale=1e27|round=trunc-toward-zero|ln=atanh-10-tab16|exp=taylor-25|ln2=693147180559945309417232121|expmax=88";

    error Domain(string what);

    /// @notice keccak256 of the spec string. The attestation carries this value.
    function specHash() internal pure returns (bytes32) {
        return keccak256(bytes(SPEC));
    }

    /// @notice a * b / RAY, truncated toward zero.
    function mul(int256 a, int256 b) internal pure returns (int256) {
        return (a * b) / RAY;
    }

    /// @notice a * RAY / b, truncated toward zero.
    function div(int256 a, int256 b) internal pure returns (int256) {
        if (b == 0) revert Domain("division by zero");
        return (a * RAY) / b;
    }

    /// @dev floor(log2(x)) for x > 0, by the same strides the TypeScript engine uses.
    function bitLength(int256 x) internal pure returns (uint256 n) {
        if (x <= 0) revert Domain("bitLength of non-positive value");
        uint256 v = uint256(x);
        while (v >= (uint256(1) << 64)) {
            v >>= 64;
            n += 64;
        }
        while (v > 1) {
            v >>= 1;
            n += 1;
        }
    }

    /// @dev ln(1 + j/16) at RAY scale, rounded half to even from a 60-digit computation.
    function lnTable(uint256 j) internal pure returns (int256) {
        if (j == 0) return 0;
        if (j == 1) return 60624621816434842580606132;
        if (j == 2) return 117783035656383454538794109;
        if (j == 3) return 171850256926659222340098946;
        if (j == 4) return 223143551314209755766295090;
        if (j == 5) return 271933715483641758831669495;
        if (j == 6) return 318453731118534615810247214;
        if (j == 7) return 362905493689368453137824346;
        if (j == 8) return 405465108108164381978013115;
        if (j == 9) return 446287102628419511532590181;
        if (j == 10) return 485507815781700807801791077;
        if (j == 11) return 523248143764547836516807225;
        if (j == 12) return 559615787935422686270888501;
        if (j == 13) return 594707107746692789514343547;
        if (j == 14) return 628608659422374137744308206;
        if (j == 15) return 661398482245365008260235839;
        revert Domain("ln table index");
    }

    /**
     * @notice Natural logarithm at RAY scale.
     *
     * x is written as m * 2^e with m in [RAY, 2*RAY), reduced a second time against the
     * table so that m/d lies within 1/16 of one, and the remaining factor comes from
     * ln(m/d) = 2 * atanh(z) with z below 1/32.
     */
    function ln(int256 x) internal pure returns (int256) {
        if (x <= 0) revert Domain("ln of non-positive value");

        int256 e = int256(bitLength(x)) - int256(bitLength(RAY));
        int256 m;
        if (e >= 0) {
            m = x / int256(uint256(1) << uint256(e));
        } else {
            m = x * int256(uint256(1) << uint256(-e));
        }

        int256 ee = e;
        while (m >= 2 * RAY) {
            m /= 2;
            ee += 1;
        }
        while (m < RAY) {
            m *= 2;
            ee -= 1;
        }

        int256 j = (m - RAY) / LN_STEP;
        int256 d = RAY + j * LN_STEP;
        int256 z = ((m - d) * RAY) / (m + d);
        int256 z2 = (z * z) / RAY;

        int256 term = z;
        int256 sum = term;
        for (uint256 k = 3; k <= 2 * LN_TERMS - 1; k += 2) {
            term = (term * z2) / RAY;
            if (term == 0) break;
            sum += term / int256(k);
        }

        return 2 * sum + lnTable(uint256(j)) + ee * LN2;
    }

    /**
     * @notice Exponential at RAY scale.
     *
     * x is split as k * ln(2) + r with |r| at most ln(2)/2, exp(r) comes from its Taylor
     * series, and the power of two is applied by exact multiplication or division.
     */
    function exp(int256 x) internal pure returns (int256) {
        if (x > EXP_MAX) revert Domain("exp overflow");
        if (x < -EXP_MAX) return 0;

        int256 k = x / LN2;
        int256 rem = x - k * LN2;
        if (rem * 2 > LN2) k += 1;
        else if (rem * 2 < -LN2) k -= 1;
        int256 r = x - k * LN2;

        int256 term = RAY;
        int256 sum = RAY;
        for (uint256 n = 1; n <= EXP_TERMS; n++) {
            term = ((term * r) / RAY) / int256(n);
            if (term == 0) break;
            sum += term;
        }

        if (k >= 0) {
            if (k > 200) revert Domain("exp overflow");
            return sum * int256(uint256(1) << uint256(k));
        }
        int256 shift = -k;
        if (shift > 200) return 0;
        return sum / int256(uint256(1) << uint256(shift));
    }

    /// @notice x^y at RAY scale, for x > 0.
    function pow(int256 x, int256 y) internal pure returns (int256) {
        if (x <= 0) revert Domain("pow of non-positive base");
        if (y == 0) return RAY;
        return exp((y * ln(x)) / RAY);
    }

    /// @notice Round a RAY value to WAD, truncating toward zero.
    function toWad(int256 x) internal pure returns (int256) {
        return x / 1e9;
    }
}
