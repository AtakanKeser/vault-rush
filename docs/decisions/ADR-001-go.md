# ADR-001: Go for the backend

- **Status:** Accepted
- **Date:** 2026-05-09

## Context

Vault Rush exists to demonstrate that I can build and run a production-style game
backend. The workload is a mix of latency-sensitive request handling (a heist finish
must validate a replay and commit in well under 200 ms), a CPU-bound component (the
deterministic engine replay), and background concurrency (telemetry fan-out, SQS
consumption, scheduled jobs). It has to deploy as small containers on Fargate and be
easy to test in CI, including race conditions.

## Decision

The API and the worker are written in Go (1.27), as a single module with two binaries.

## Consequences

Positive:

- Goroutines and channels map directly onto the telemetry pipeline I wanted to build:
  a bounded channel, a fixed worker pool, non-blocking publish, `sync.WaitGroup` drain
  on shutdown. The design in `docs/architecture.md` §3 is idiomatic Go rather than a
  library I glued in.
- `go test -race` runs in CI on every push. For code whose whole point is concurrency,
  a built-in race detector is worth more than any framework feature.
- Static binaries ship in `gcr.io/distroless/static` images with no shell and no libc;
  the API image is a few tens of megabytes and cold-starts on Fargate in well under a
  second, which matters for request-count autoscaling.
- The standard library covers HTTP, JSON, context propagation and graceful shutdown
  without third-party frameworks, so the request path is easy to read in a review.
- The AWS SDK v2 for Go is first-class for DynamoDB, SQS and SSM.

Negative:

- The engine had to be written twice (Go for the server, TypeScript for the client).
  With a Node backend I could have shared one implementation. I accepted this and
  turned it into a feature — the cross-language golden fixture test — but it is real
  ongoing cost: every engine change touches two codebases.
- Error handling is verbose and easy to get subtly wrong (wrapped errors, sentinel
  comparisons across package boundaries). I lean on `errors.Is/As` and a small set of
  typed API errors to keep the HTTP error mapping in one place.
- Go's game-industry ecosystem is thinner than C#'s. That is irrelevant for a service
  backend but would matter if this project grew server-side simulation.

## Alternatives considered

- **Node.js / TypeScript** — one engine implementation shared with the client, very fast
  iteration. Rejected because the single-threaded event loop makes the CPU-bound replay
  step compete with request handling, and because the role I am targeting is a Go
  backend role; the portfolio should show that.
- **C# / .NET** — excellent Unity synergy for the planned native client, good async
  story. Rejected for the same positioning reason and because container images and cold
  starts are heavier than Go's.
- **Rust** — best raw performance and memory safety. Rejected for MVP velocity: the
  service is I/O-bound on DynamoDB and Redis, so Rust's advantages would not show up in
  the numbers that matter here, and iteration speed would suffer.
- **Java / Kotlin (Spring)** — mature, but JVM memory footprint and startup time work
  against small autoscaled Fargate tasks.
