# syntax=docker/dockerfile:1
#
# Vault Rush — worker image (backend/cmd/worker).
#
# The worker consumes the telemetry/event SQS queue and runs scheduled jobs (event
# provisioning, leaderboard reconciliation). It shares the module with the API, so the
# build stage is identical apart from the package path; the two Dockerfiles are kept
# separate so each image can be built, cached and rolled out independently.
#
#   docker build -f infrastructure/docker/worker.Dockerfile --build-arg VERSION=$(git rev-parse --short HEAD) -t vault-rush-worker .

ARG GO_VERSION=1.27

# ---------- build stage ----------
FROM golang:${GO_VERSION}-alpine AS build

ARG VERSION=dev
ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src

COPY backend/go.mod backend/go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY backend/ ./

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/worker ./cmd/worker

# ---------- runtime stage ----------
FROM gcr.io/distroless/static-debian12:nonroot

ARG VERSION=dev
LABEL org.opencontainers.image.title="vault-rush-worker" \
      org.opencontainers.image.source="https://github.com/atakank/vault-rush" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app
COPY --from=build /out/worker /app/worker

# The worker is not behind a load balancer; 8080 is exposed only so that its /healthz
# and /metrics endpoints can be scraped inside the task network if the binary serves them.
ENV PORT=8080
EXPOSE 8080

# No HEALTHCHECK: see api.Dockerfile. ECS restarts the task when the process exits; the
# worker exits non-zero if it cannot reach its queue after the startup grace period.

USER nonroot:nonroot
ENTRYPOINT ["/app/worker"]
