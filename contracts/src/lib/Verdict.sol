// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BSA1} from "./BSA1.sol";

/**
 * @title Verdict
 * @notice The onchain recomputation of a single disputed quantity.
 *
 * Settlement is optimistic. A bonded proposer publishes a claim root; a challenger bonds
 * and names one `(round, cell, mixture element)` triple; this library recomputes exactly
 * that quantity from the sealed transcript commitment and the revealed calibration slice,
 * under BSA-1. The loser's bond goes to the winner.
 *
 * Every function mirrors `packages/core/src/stats.ts` operation for operation.
 */
library Verdict {
    error AlphabetMismatch();
    error EmptySample();
    error EmptyCalibration();
    error EmptyMixture();
    error LambdaRange();

    /**
     * @notice Empirical distribution from counts, at RAY scale.
     *
     * p_i = floor(count_i * RAY / n), and the truncation residual goes to the index with
     * the largest count, ties broken by the lowest index, so the probabilities sum to
     * exactly RAY and the result is a function of the counts alone.
     */
    function empirical(uint256[] memory counts) internal pure returns (int256[] memory p) {
        uint256 n;
        for (uint256 i = 0; i < counts.length; i++) n += counts[i];
        if (n == 0) revert EmptySample();

        p = new int256[](counts.length);
        int256 total;
        for (uint256 i = 0; i < counts.length; i++) {
            p[i] = (int256(counts[i]) * BSA1.RAY) / int256(n);
            total += p[i];
        }

        int256 residual = BSA1.RAY - total;
        if (residual != 0) {
            uint256 best;
            for (uint256 i = 1; i < counts.length; i++) {
                if (counts[i] > counts[best]) best = i;
            }
            p[best] += residual;
        }
    }

    /**
     * @notice Jensen-Shannon divergence in nats, at RAY scale.
     *
     * JSD(P || Q) = (KL(P || M) + KL(Q || M)) / 2 with M = (P + Q) / 2. The result lies in
     * [0, ln 2]; indices where the mixture is zero carry no mass in either argument.
     */
    function jsd(int256[] memory p, int256[] memory q) internal pure returns (int256) {
        if (p.length != q.length) revert AlphabetMismatch();

        int256 acc;
        for (uint256 i = 0; i < p.length; i++) {
            int256 mi = (p[i] + q[i]) / 2;
            if (mi == 0) continue;
            if (p[i] > 0) acc += BSA1.mul(p[i], BSA1.ln(BSA1.div(p[i], mi)));
            if (q[i] > 0) acc += BSA1.mul(q[i], BSA1.ln(BSA1.div(q[i], mi)));
        }
        int256 out = acc / 2;
        return out < 0 ? int256(0) : out;
    }

    /**
     * @notice Split-conformal rank p-value.
     *
     * p = (1 + #{ i : S0_i >= S }) / (m + 1). The tie rule is `>=`, the conservative
     * direction, and it is part of the canonical spec because single-token outputs are
     * discrete and low-cardinality.
     */
    function conformalP(int256 audited, int256[] memory calibration) internal pure returns (int256) {
        uint256 m = calibration.length;
        if (m == 0) revert EmptyCalibration();
        uint256 atLeast;
        for (uint256 i = 0; i < m; i++) {
            if (calibration[i] >= audited) atLeast += 1;
        }
        return (int256(1 + atLeast) * BSA1.RAY) / int256(m + 1);
    }

    /**
     * @notice Admissible p-to-e calibrator, e = lambda * p^(lambda - 1).
     *
     * It integrates to 1 over the unit interval, so its expectation under any super-uniform
     * p-value is at most 1, which is the property the supermartingale needs.
     */
    function calibrate(int256 p, int256 lambda) internal pure returns (int256) {
        if (lambda <= 0 || lambda >= BSA1.RAY) revert LambdaRange();
        return BSA1.mul(lambda, BSA1.pow(p, lambda - BSA1.RAY));
    }

    /// @notice Minimum across the declared mixture set. Evidence counts only when a round is
    /// anomalous under every permitted element.
    function minOverMixture(int256[] memory perElement) internal pure returns (int256 best) {
        if (perElement.length == 0) revert EmptyMixture();
        best = perElement[0];
        for (uint256 i = 1; i < perElement.length; i++) {
            if (perElement[i] < best) best = perElement[i];
        }
    }

    /// @notice Arithmetic mean of the cell e-values, valid under arbitrary dependence.
    function combineCells(int256[] memory cellEValues) internal pure returns (int256) {
        if (cellEValues.length == 0) revert EmptyMixture();
        int256 acc;
        for (uint256 i = 0; i < cellEValues.length; i++) acc += cellEValues[i];
        return acc / int256(cellEValues.length);
    }

    /// @notice The Ville boundary in log space, ln(1 / alpha).
    function villeBoundary(int256 alpha) internal pure returns (int256) {
        return BSA1.ln(BSA1.div(BSA1.RAY, alpha));
    }

    /**
     * @notice The full single-cell recomputation an adjudication performs.
     * @param auditedCounts the round's authenticated responses for the disputed cell
     * @param referenceCounts the fingerprint partition for the disputed mixture element
     * @param calibration the revealed calibration statistics for that round and element
     * @param lambda the calibrator parameter pinned in the attestation
     */
    function recomputeCell(
        uint256[] memory auditedCounts,
        uint256[] memory referenceCounts,
        int256[] memory calibration,
        int256 lambda
    ) internal pure returns (int256 statistic, int256 p, int256 e) {
        int256[] memory audited = empirical(auditedCounts);
        int256[] memory ref = empirical(referenceCounts);
        statistic = jsd(audited, ref);
        p = conformalP(statistic, calibration);
        e = calibrate(p, lambda);
    }
}
