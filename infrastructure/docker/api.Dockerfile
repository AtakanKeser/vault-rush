# syntax=docker/dockerfile:1
#
# Vault Rush — API image (backend/cmd/api).
#
# Build context is the repository root so the same Dockerfile works locally and in CI:
#   docker build -f infrastructure/docker/api.Dockerfile --build-arg VERSION=$(git rev-parse --short HEAD) -t vault-rush-api .
#
# Layering strategy: go.mod/go.sum are copied and downloaded before the source tree so
# the module layer is reused across builds unless dependencies change. BuildKit cache
# mounts additionally persist the module and build caches across builds.

ARG GO_VERSION=1.27

# ---------- build stage ----------
FROM golang:${GO_VERSION}-alpine AS build

ARG VERSION=dev
ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src

# Dependency layer (changes rarely).
COPY backend/go.mod backend/go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Source layer (changes often).
COPY backend/ ./

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/api ./cmd/api

# ---------- runtime stage ----------
# distroless/static: no shell, no package manager, no libc — the Go binary is statically linked.
# The :nonroot tag runs as uid 65532 and ships CA certificates and tzdata, which is all the
# AWS SDK needs to talk to DynamoDB/SQS over TLS.
FROM gcr.io/distroless/static-debian12:nonroot

ARG VERSION=dev
LABEL org.opencontainers.image.title="vault-rush-api" \
      org.opencontainers.image.source="https://github.com/atakank/vault-rush" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app
COPY --from=build /out/api /app/api

ENV PORT=8080
EXPOSE 8080

# No HEALTHCHECK on purpose: distroless has no shell or curl to execute one, and the
# orchestrators used here do their own probing — the ECS/ALB target group hits GET /healthz,
# and docker-compose services that depend on the API poll /readyz from their own container.
# Baking a probe binary into the image would only add attack surface for no benefit.

USER nonroot:nonroot
ENTRYPOINT ["/app/api"]
