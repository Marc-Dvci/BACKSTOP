# BACKSTOP indexer

Envio HyperIndex over the BACKSTOP contracts on Monad.

The index is what makes the public reliability and price index possible: it turns a stream of
round closures into the running product for every endpoint, the distance to the boundary fixed
at issuance, the realised detection delay per settled policy, the void rate against each
attestation's declared circuit breaker, the pool's collateralisation, and the protocol-wide loss
ratio. Every one of those is a derived or aggregated entity rather than a mirror of an event, so
a consumer reads one row instead of reconstructing a join and a chain call.

## Entities

| Entity | What it answers |
|---|---|
| `Endpoint` | how far this endpoint's running product is from its boundary, whether coverage is frozen, what is outstanding against it |
| `Round` | the seed, the transcript root, the reveal root, E(t), the cumulative log, the claim root, and whether the round was disputed |
| `Policy` | the terms, the quote components that produced the price, and the realised detection delay once it settles |
| `Pool` | collateralisation in basis points, updated on every capital event |
| `Producer` | realised void rate per evidence producer |
| `Issuer` | versions issued, retired and suspended, and challenges upheld against them |
| `ProtocolIndex` | one row: loss ratio, mean detection delay, largest settled batch and the gas it took |

## Run it

```bash
pnpm install
pnpm codegen
pnpm dev          # local Postgres and Hasura through docker
```

`config.yaml` addresses are filled in by `scripts/sync-deployment.mjs` after `forge script
script/Deploy.s.sol`, so the indexer, the SDK and the app read one source of addresses.

## Queries the app uses

```graphql
query Index {
  ProtocolIndex(where: { id: { _eq: "index" } }) {
    endpointsMeasured
    endpointsCrossed
    policiesSettled
    totalPaidOut
    lossRatioBps
    detectionDelaySum
    detectionDelayCount
    maxBatchSize
    maxBatchGas
  }
  Endpoint(order_by: { distanceBps: desc }) {
    versionId
    endpointId
    settlementEligible
    versionLogRay
    distanceBps
    crossed
    crossedAtRound
    voidRateBps
    outstandingNotional
    issuer { id agentId challengesUpheld }
  }
}
```

```graphql
query EndpointTrace($versionId: String!) {
  Round(where: { endpoint_id: { _eq: $versionId } }, order_by: { round: asc }) {
    round
    eRoundRay
    cumLogRay
    warning
    versionCrossed
    claimRoot
    disputed
  }
}
```
