// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BSA1} from "../src/lib/BSA1.sol";
import {Verdict} from "../src/lib/Verdict.sol";

/**
 * The differential harness.
 *
 * `packages/core/scripts/emit-vectors.ts` runs the TypeScript engine over the whole verdict
 * path and writes the exact integers it produced. This test reads that file and asserts the
 * Solidity adjudicator produces the same integers from the same inputs.
 *
 * Equality is asserted exactly. A divergence in the last bit near the boundary is the
 * difference between a claim and no claim, so a tolerance here would defeat the purpose of
 * having a canonical arithmetic at all.
 */
contract DifferentialTest is Test {
    string internal json;
    uint256 internal alphabet;
    uint256 internal mCal;
    uint256 internal cases;
    int256 internal lambda;

    function setUp() public {
        json = vm.readFile("vectors/bsa1-vectors.json");
        alphabet = vm.parseJsonUint(json, ".alphabet");
        mCal = vm.parseJsonUint(json, ".m");
        cases = vm.parseJsonUint(json, ".cases");
        lambda = vm.parseJsonInt(json, ".lambda");
    }

    function test_SpecHashMatchesTypeScript() public view {
        bytes32 expected = abi.decode(vm.parseJson(json, ".specHash"), (bytes32));
        assertEq(BSA1.specHash(), expected, "canonical arithmetic spec hash");
    }

    function test_Ln() public view {
        int256[] memory x = vm.parseJsonIntArray(json, ".ln.x");
        int256[] memory y = vm.parseJsonIntArray(json, ".ln.y");
        for (uint256 i = 0; i < x.length; i++) {
            assertEq(BSA1.ln(x[i]), y[i], "ln");
        }
    }

    function test_Exp() public view {
        int256[] memory x = vm.parseJsonIntArray(json, ".exp.x");
        int256[] memory y = vm.parseJsonIntArray(json, ".exp.y");
        for (uint256 i = 0; i < x.length; i++) {
            assertEq(BSA1.exp(x[i]), y[i], "exp");
        }
    }

    function test_Pow() public view {
        int256[] memory x = vm.parseJsonIntArray(json, ".pow.x");
        int256[] memory y = vm.parseJsonIntArray(json, ".pow.y");
        int256[] memory z = vm.parseJsonIntArray(json, ".pow.z");
        for (uint256 i = 0; i < x.length; i++) {
            assertEq(BSA1.pow(x[i], y[i]), z[i], "pow");
        }
    }

    function test_Empirical() public view {
        uint256[] memory counts = vm.parseJsonUintArray(json, ".empirical.counts");
        int256[] memory expected = vm.parseJsonIntArray(json, ".empirical.out");
        for (uint256 c = 0; c < cases; c++) {
            uint256[] memory slice = _sliceUint(counts, c * alphabet, alphabet);
            int256[] memory got = Verdict.empirical(slice);
            for (uint256 i = 0; i < alphabet; i++) {
                assertEq(got[i], expected[c * alphabet + i], "empirical");
            }
        }
    }

    function test_Jsd() public view {
        uint256[] memory p = vm.parseJsonUintArray(json, ".jsd.p");
        uint256[] memory q = vm.parseJsonUintArray(json, ".jsd.q");
        int256[] memory expected = vm.parseJsonIntArray(json, ".jsd.out");
        for (uint256 c = 0; c < cases; c++) {
            int256[] memory dp = Verdict.empirical(_sliceUint(p, c * alphabet, alphabet));
            int256[] memory dq = Verdict.empirical(_sliceUint(q, c * alphabet, alphabet));
            assertEq(Verdict.jsd(dp, dq), expected[c], "jsd");
        }
    }

    function test_ConformalAndCalibrator() public view {
        int256[] memory calibration = vm.parseJsonIntArray(json, ".conformal.calibration");
        int256[] memory audited = vm.parseJsonIntArray(json, ".conformal.audited");
        int256[] memory pExpected = vm.parseJsonIntArray(json, ".conformal.out");
        int256[] memory eExpected = vm.parseJsonIntArray(json, ".calibrate.out");

        for (uint256 c = 0; c < cases; c++) {
            int256[] memory slice = _sliceInt(calibration, c * mCal, mCal);
            int256 p = Verdict.conformalP(audited[c], slice);
            assertEq(p, pExpected[c], "conformal p");
            assertEq(Verdict.calibrate(p, lambda), eExpected[c], "calibrated e");
        }
    }

    function test_Combination() public view {
        uint256 mixture = vm.parseJsonUint(json, ".mixture");
        uint256 cells = vm.parseJsonUint(json, ".cells");
        int256[] memory mixIn = vm.parseJsonIntArray(json, ".minOverMixture.input");
        int256[] memory mixOut = vm.parseJsonIntArray(json, ".minOverMixture.out");
        int256[] memory cellIn = vm.parseJsonIntArray(json, ".combineCells.input");
        int256[] memory cellOut = vm.parseJsonIntArray(json, ".combineCells.out");

        for (uint256 c = 0; c < mixOut.length; c++) {
            assertEq(Verdict.minOverMixture(_sliceInt(mixIn, c * mixture, mixture)), mixOut[c], "min over M");
            assertEq(Verdict.combineCells(_sliceInt(cellIn, c * cells, cells)), cellOut[c], "mean over cells");
        }
    }

    function test_VilleBoundary() public view {
        int256[] memory alpha = vm.parseJsonIntArray(json, ".ville.alpha");
        int256[] memory expected = vm.parseJsonIntArray(json, ".ville.out");
        for (uint256 i = 0; i < alpha.length; i++) {
            assertEq(Verdict.villeBoundary(alpha[i]), expected[i], "ville boundary");
        }
    }

    function _sliceUint(uint256[] memory a, uint256 start, uint256 len)
        private
        pure
        returns (uint256[] memory out)
    {
        out = new uint256[](len);
        for (uint256 i = 0; i < len; i++) out[i] = a[start + i];
    }

    function _sliceInt(int256[] memory a, uint256 start, uint256 len) private pure returns (int256[] memory out) {
        out = new int256[](len);
        for (uint256 i = 0; i < len; i++) out[i] = a[start + i];
    }
}
