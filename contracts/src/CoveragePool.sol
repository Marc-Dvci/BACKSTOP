// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title CoveragePool
 * @notice Underwriter capital. Maximum outstanding liability is fully collateralised at all
 *         times.
 *
 *     reservedCapital = sum of notional over every live policy
 *     freeCapital     = totalAssets - reservedCapital
 *
 * Claims are correlated by construction: one provider swapping one model triggers every
 * policy covering that provider and model, and plausibly every policy on sibling endpoints
 * running the same stack. Full collateralisation makes that survivable. The concentration
 * caps are the control, and realised correlation across endpoints is measured by the index
 * rather than assumed.
 *
 * Leverage is out of scope. If it were added, impairment would be a uniform pro-rata
 * haircut and never first-come.
 */
contract CoveragePool {
    IERC20 public immutable asset;
    address public governance;

    /// @notice The contract permitted to reserve, release and pay out. The PolicyRegistry.
    address public policyManager;

    uint256 public totalShares;
    uint256 public totalAssets;
    uint256 public reservedCapital;

    mapping(address => uint256) public sharesOf;

    // ---------------------------------------------------------------- concentration caps

    /// @notice Maximum notional a single buyer may hold across the pool.
    uint256 public perBuyerCap;
    /// @notice Maximum notional outstanding against one endpoint.
    uint256 public perEndpointCap;
    /// @notice Maximum notional outstanding against one provider and model.
    uint256 public perProviderModelCap;
    /// @notice Maximum fraction of free capital a single policy may reserve, in basis points.
    uint256 public singlePolicyBps = 2000;

    mapping(address => uint256) public buyerExposure;
    mapping(bytes32 => uint256) public endpointExposure;
    mapping(bytes32 => uint256) public providerModelExposure;

    /// @notice Versions this pool is willing to write against.
    mapping(uint256 => bool) public eligibleVersion;
    /// @notice Issuers this pool is willing to write against.
    mapping(address => bool) public eligibleIssuer;

    event Deposited(address indexed underwriter, uint256 assets, uint256 shares);
    event Withdrawn(address indexed underwriter, uint256 assets, uint256 shares);
    event Reserved(uint256 indexed policyId, uint256 notional);
    event Released(uint256 indexed policyId, uint256 notional, uint256 premiumEarned);
    event PaidOut(uint256 indexed policyId, address indexed to, uint256 notional);
    event PremiumReceived(uint256 amount);
    event EligibilityChanged(uint256 indexed versionId, bool eligible);
    event IssuerEligibilityChanged(address indexed issuer, bool eligible);
    event CapsChanged(uint256 perBuyer, uint256 perEndpoint, uint256 perProviderModel, uint256 singlePolicyBps);

    error NotGovernance();
    error NotPolicyManager();
    error InsufficientFreeCapital(uint256 requested, uint256 available);
    error CapExceeded(string which);
    error VersionNotEligible();
    error IssuerNotEligible();
    error ZeroAmount();
    error TransferFailed();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier onlyPolicyManager() {
        if (msg.sender != policyManager) revert NotPolicyManager();
        _;
    }

    constructor(IERC20 asset_, address governance_) {
        asset = asset_;
        governance = governance_;
        perBuyerCap = type(uint256).max;
        perEndpointCap = type(uint256).max;
        perProviderModelCap = type(uint256).max;
    }

    // ---------------------------------------------------------------- governance

    function setPolicyManager(address manager) external onlyGovernance {
        policyManager = manager;
    }

    function setGovernance(address next) external onlyGovernance {
        governance = next;
    }

    function setCaps(uint256 buyer, uint256 endpoint, uint256 providerModel, uint256 singleBps)
        external
        onlyGovernance
    {
        perBuyerCap = buyer;
        perEndpointCap = endpoint;
        perProviderModelCap = providerModel;
        singlePolicyBps = singleBps;
        emit CapsChanged(buyer, endpoint, providerModel, singleBps);
    }

    function setVersionEligible(uint256 versionId, bool eligible) external onlyGovernance {
        eligibleVersion[versionId] = eligible;
        emit EligibilityChanged(versionId, eligible);
    }

    function setIssuerEligible(address issuer, bool eligible) external onlyGovernance {
        eligibleIssuer[issuer] = eligible;
        emit IssuerEligibilityChanged(issuer, eligible);
    }

    // ---------------------------------------------------------------- underwriters

    function freeCapital() public view returns (uint256) {
        return totalAssets > reservedCapital ? totalAssets - reservedCapital : 0;
    }

    function collateralisationBps() external view returns (uint256) {
        if (reservedCapital == 0) return type(uint256).max;
        return (totalAssets * 10000) / reservedCapital;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        if (totalShares == 0 || totalAssets == 0) return assets;
        return (assets * totalShares) / totalAssets;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        if (totalShares == 0) return shares;
        return (shares * totalAssets) / totalShares;
    }

    function deposit(uint256 assets) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        shares = convertToShares(assets);
        _pull(msg.sender, assets);
        totalAssets += assets;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposited(msg.sender, assets, shares);
    }

    /**
     * @notice Withdraw against free capital only.
     *
     * The bound is recomputed at withdrawal time, so an underwriter cannot remove collateral
     * backing a live notional no matter what has happened since the deposit.
     */
    function withdraw(uint256 shares) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        assets = convertToAssets(shares);
        uint256 free = freeCapital();
        if (assets > free) revert InsufficientFreeCapital(assets, free);

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        totalAssets -= assets;
        _push(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /// @notice The largest notional the pool would currently accept on one policy.
    function maxNotional() external view returns (uint256) {
        return (freeCapital() * singlePolicyBps) / 10000;
    }

    // ---------------------------------------------------------------- policy lifecycle

    struct ReserveParams {
        uint256 policyId;
        uint256 versionId;
        address issuer;
        address buyer;
        bytes32 endpointId;
        bytes32 providerModelKey;
        uint256 notional;
    }

    /// @notice Reserve a notional atomically, or revert.
    function reserve(ReserveParams calldata p) external onlyPolicyManager {
        if (!eligibleVersion[p.versionId]) revert VersionNotEligible();
        if (!eligibleIssuer[p.issuer]) revert IssuerNotEligible();

        uint256 free = freeCapital();
        if (p.notional > free) revert InsufficientFreeCapital(p.notional, free);
        if (p.notional > (free * singlePolicyBps) / 10000) revert CapExceeded("singlePolicy");
        if (buyerExposure[p.buyer] + p.notional > perBuyerCap) revert CapExceeded("perBuyer");
        if (endpointExposure[p.endpointId] + p.notional > perEndpointCap) revert CapExceeded("perEndpoint");
        if (providerModelExposure[p.providerModelKey] + p.notional > perProviderModelCap) {
            revert CapExceeded("perProviderModel");
        }

        reservedCapital += p.notional;
        buyerExposure[p.buyer] += p.notional;
        endpointExposure[p.endpointId] += p.notional;
        providerModelExposure[p.providerModelKey] += p.notional;
        emit Reserved(p.policyId, p.notional);
    }

    /// @notice Release a reserve on expiry without a crossing, and book the earned premium.
    function release(
        uint256 policyId,
        address buyer,
        bytes32 endpointId,
        bytes32 providerModelKey,
        uint256 notional,
        uint256 premiumEarned
    ) external onlyPolicyManager {
        _unreserve(buyer, endpointId, providerModelKey, notional);
        if (premiumEarned > 0) {
            _pull(msg.sender, premiumEarned);
            totalAssets += premiumEarned;
            emit PremiumReceived(premiumEarned);
        }
        emit Released(policyId, notional, premiumEarned);
    }

    /// @notice Release a reserve into a payout. The pool pays the notional in full.
    function payout(
        uint256 policyId,
        address to,
        address buyer,
        bytes32 endpointId,
        bytes32 providerModelKey,
        uint256 notional,
        uint256 premiumEarned
    ) external onlyPolicyManager {
        _unreserve(buyer, endpointId, providerModelKey, notional);
        if (premiumEarned > 0) {
            _pull(msg.sender, premiumEarned);
            totalAssets += premiumEarned;
            emit PremiumReceived(premiumEarned);
        }
        totalAssets -= notional;
        _push(to, notional);
        emit PaidOut(policyId, to, notional);
    }

    function _unreserve(address buyer, bytes32 endpointId, bytes32 providerModelKey, uint256 notional) private {
        reservedCapital -= notional;
        buyerExposure[buyer] -= notional;
        endpointExposure[endpointId] -= notional;
        providerModelExposure[providerModelKey] -= notional;
    }

    function _pull(address from, uint256 amount) private {
        if (!asset.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        if (!asset.transfer(to, amount)) revert TransferFailed();
    }
}
