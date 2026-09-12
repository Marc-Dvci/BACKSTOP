# BACKSTOP

.DEFAULT_GOAL := help
SHELL := /bin/bash

help: ## List the targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install everything
	pnpm install
	cd contracts && forge install foundry-rs/forge-std@v1.16.2 --no-git
	cd contracts && forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git

build: ## Build the engine, the SDK, the CLI and the contracts
	pnpm --filter @backstop/core build
	pnpm --filter @backstop/sdk build
	pnpm --filter @backstop/cli build
	cd contracts && forge build

test: ## Run every test: engine, contracts, invariants, differential
	pnpm --filter @backstop/core test
	cd contracts && forge test -vv

demo: build ## One command: the whole protocol, end to end, on a local chain
	node scripts/demo.mjs --rounds 18 --switch-at 6 --draws 96

endpoint: ## An OpenAI-compatible endpoint serving the measured laws. SERVE=bf16, q8_0 or q4km
	node scripts/reference-endpoint.mjs --serve $(or $(SERVE),bf16)

ci-audit: build ## The CLI against that endpoint, attested and substituted, both verdicts asserted
	node scripts/ci-audit.mjs --rounds 6 --draws 96

gate-zero: ## The lifetime Type-I bound against a known null
	pnpm --filter @backstop/core exec tsx scripts/gate-zero.ts --trials 4000 --pools 40 --json ../../docs/results/gate-zero.json

bench: ## Benign versus substitution, and the detection delay curve
	pnpm --filter @backstop/core exec tsx scripts/bench.ts --reps 200 --json ../../docs/results/bench.json
	pnpm --filter @backstop/core exec tsx scripts/bench-scaling.ts --reps 120 --json ../../docs/results/bench-scaling.json

vectors: ## Regenerate the cross-implementation test vectors and check both sides agree
	pnpm --filter @backstop/core run vectors
	pnpm --filter @backstop/core exec tsx scripts/emit-webauthn.ts
	cd contracts && forge test --match-contract DifferentialTest -vv
	cd contracts && forge test --match-contract WebAuthnTest -vv

harness: ## Measure a real open-weight model across three quantisations
	node bench/harness.mjs --draws 500 --cells 8
	node bench/analyse.mjs --json ../docs/results/envelope.json

web: ## Run the app
	pnpm --filter @backstop/web dev

deploy-testnet: ## Deploy to Monad testnet and sync the addresses everywhere
	set -a && source .env && set +a && \
	  cd contracts && forge script script/Deploy.s.sol --rpc-url $$MONAD_TESTNET_RPC --broadcast --slow
	node scripts/sync-deployment.mjs 10143

register-agent: ## Register the auditor as an ERC-8004 agent on Monad
	set -a && source .env && set +a && \
	  cd contracts && forge script script/RegisterAgent.s.sol --rpc-url $$MONAD_TESTNET_RPC --broadcast

seed-testnet: ## Issue attestations, fund the pool and run the audit on testnet
	set -a && source .env && set +a && node scripts/seed-testnet.mjs

indexer: ## Self-hosted Envio indexer over the testnet deployment, GraphQL on :8080
	cd indexer && docker compose up

round-record: ## Export the crossing round as a replayable record, checked against chain
	node scripts/export-round.mjs --out docs/results/round-primary-crossing.json

replay: build round-record ## Recompute the published verdict from the record alone
	node packages/cli/dist/index.js replay --record docs/results/round-primary-crossing.json --attestation attestations/reference.json --pool pools/v1.json

.PHONY: help install build test demo endpoint ci-audit gate-zero bench vectors harness web deploy-testnet register-agent seed-testnet indexer round-record replay
