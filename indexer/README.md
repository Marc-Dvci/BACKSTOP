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

Self-hosted, no account anywhere. One command brings up Postgres, Hasura and the indexer, which
backfills from the deployment block on Monad testnet and then follows the head:

```bash
cd indexer
docker compose up
```

GraphQL is then at `http://localhost:8080/v1/graphql`, console at `http://localhost:8080`,
admin secret `backstop`. The app reads the same endpoint through `NEXT_PUBLIC_INDEXER_URL` and
renders it at `/protocol`; unset, it defaults to that local endpoint.

Three things about this stack are load-bearing and were each found the hard way:

- **CA certificates.** Envio's sync engine is a native binary linked against OpenSSL and reads
  the system trust store, not Node's bundled one. On a `-slim` base image there is none, every
  HTTPS call to the RPC fails certificate verification, and the only symptom is a chain height
  that stays at zero. The compose file installs `ca-certificates`.
- **Block range.** Monad's own public RPC caps `eth_getLogs` at a 100-block range and rejects a
  wider one outright. Two other public endpoints serve 1000, so they lead and Monad's sits
  behind them as the last fallback, with the interval ceiling pinned so no query exceeds what
  the endpoint will answer. `for: sync` is required: HyperSync exists for this chain, so an RPC
  is otherwise treated as a fallback and never used.
- **Hasura endpoint.** `HASURA_GRAPHQL_ENDPOINT` is the metadata URL, not the host. Pointed at
  the host, table tracking 404s and the tables are never exposed.

HyperSync is faster than any RPC and is a one-line swap in `config.yaml` once `ENVIO_API_TOKEN`
is set. It is not the default here because the point is that the indexer runs with no account.

## Two derived quantities worth naming

`Endpoint.voidRateBps` divides by the executions a round committed to, and `openRound` records
that count without emitting it. The count is recovered by selecting `transaction.input` and
decoding the last argument in the handler, which is why `field_selection` is declared.

`ProtocolIndex.lossRatioBps` and `Pool.collateralisationBps` are ratios of two unbounded token
amounts. A crossing pays the full notional against a premium worth basis points of it, so the
realised ratio runs into the millions and does not fit in a 32-bit integer. Both are `BigInt`.

## The query the app runs

The `/protocol` page reads all of it in one round trip. This is the document, verbatim from
`apps/web/lib/indexer.ts`, and it is also printed on the page so what a reader pastes into the
console is what produced what they are looking at.

```graphql
query BackstopIndex {
  ProtocolIndex {
    endpointsMeasured
    endpointsSettlementEligible
    endpointsCrossed
    endpointsInWarning
    roundsClosed
    totalScheduledExecutions
    totalVoidedExecutions
    policiesWritten
    policiesSettled
    totalNotionalWritten
    totalPaidOut
    totalPremiumEarned
    lossRatioBps
    detectionDelaySum
    detectionDelayCount
    maxBatchSize
    maxBatchGas
    updatedAt
  }
  Endpoint(order_by: { versionId: asc }) {
    id
    versionId
    status
    settlementEligible
    distanceBps
    inWarningRegion
    crossed
    crossedAtRound
    roundsClosed
    scheduledTotal
    voidedTotal
    voidRateBps
    outstandingNotional
    policiesWritten
    policiesSettled
    totalPaidOut
    totalPremiumEarned
  }
  Policy(order_by: { policyId: asc }) {
    id
    policyId
    status
    notional
    premium
    startRound
    settledAtRound
    detectionDelayRounds
    paidOut
  }
}
```
