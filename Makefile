SHELL := /bin/bash
export PATH := /opt/homebrew/bin:$(PATH)

API_PORT ?= 8080
BASE_URL ?= http://localhost:$(API_PORT)

.PHONY: help dev-api dev-worker dev-client dev-admin test test-race test-integration lint fixtures seed \
        compose-up compose-down compose-logs load-smoke load-leaderboard load-heist build

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---- local development (zero dependencies) ----

dev-api: ## Run the API with in-memory storage/cache on $(API_PORT)
	cd backend && PORT=$(API_PORT) STORAGE=memory CACHE=memory QUEUE=inline LOG_LEVEL=debug go run ./cmd/api

dev-worker: ## Run the worker (scheduler only in inline mode)
	cd backend && PORT=8083 STORAGE=memory CACHE=memory QUEUE=inline go run ./cmd/worker

dev-client: ## Run the game client (Vite, port 5173)
	cd client && npm install && VITE_API_URL=$(BASE_URL) npm run dev

dev-admin: ## Run the LiveOps panel (Vite, port 3000, proxies to $(API_PORT))
	cd admin && npm install && VITE_API_URL=$(BASE_URL) npm run dev

seed: ## Simulate 200 bot players against $(BASE_URL)
	cd backend && go run ./cmd/seed -base $(BASE_URL) -players 200 -runs 3

# ---- quality ----

test: ## Unit tests (backend + client engine)
	cd backend && go test ./...
	cd client && npm test --silent

test-race: ## Backend unit tests with the race detector and coverage
	cd backend && go test -race -coverprofile=coverage.out ./... && go tool cover -func=coverage.out | tail -1

test-integration: ## Conformance suites against Redis + DynamoDB Local (compose must be up)
	cd backend && REDIS_ADDR=localhost:$${REDIS_PORT:-6380} DYNAMODB_ENDPOINT=http://localhost:$${DYNAMODB_PORT:-8000} \
		go test -tags=integration -count=1 ./internal/store/dynamo/ ./internal/cache/redis/ -v

lint: ## gofmt + go vet + staticcheck (if installed) + client typecheck
	cd backend && test -z "$$(gofmt -l .)" && go vet ./... && (command -v staticcheck >/dev/null && staticcheck ./... || echo "staticcheck not installed, skipped")
	cd client && npm run typecheck
	cd admin && npm run typecheck

fixtures: ## Regenerate the cross-language golden fixtures from the Go engine
	cd backend && UPDATE_FIXTURES=1 go test ./pkg/engine/ -run TestGoldenFixtures
	cp backend/pkg/engine/testdata/fixtures.json client/src/engine/fixtures.json

build: ## Build backend binaries into backend/bin
	cd backend && go build -trimpath -ldflags="-s -w" -o bin/api ./cmd/api && go build -trimpath -ldflags="-s -w" -o bin/worker ./cmd/worker

# ---- full stack ----

compose-up: ## Build and start the full stack (Redis, DynamoDB Local, ElasticMQ, api, worker, client, admin)
	docker compose up --build -d

compose-down: ## Stop the stack and remove volumes
	docker compose down -v

compose-logs: ## Tail api + worker logs
	docker compose logs -f api worker

# ---- load tests (k6) ----

load-smoke: ## 1 VU smoke test
	k6 run -e BASE_URL=$(BASE_URL) load-tests/k6/smoke.js

load-leaderboard: ## Leaderboard read path under load (VUS, DURATION overridable)
	k6 run -e BASE_URL=$(BASE_URL) -e VUS=$${VUS:-200} -e DURATION=$${DURATION:-60s} load-tests/k6/leaderboard.js

load-heist: ## Full start→play→finish flow with the deterministic bot
	k6 run -e BASE_URL=$(BASE_URL) -e VUS=$${VUS:-100} -e DURATION=$${DURATION:-60s} load-tests/k6/heist-flow.js
