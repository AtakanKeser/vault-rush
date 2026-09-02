# syntax=docker/dockerfile:1
#
# Vault Rush — LiveOps admin dashboard (Vite + React), served by nginx.
#
# nginx serves the SPA and reverse-proxies the API's admin surface so the dashboard is
# same-origin with the API it manages:
#   /admin/*  /healthz  /readyz  /metrics   ->  ${API_UPSTREAM}   (default http://api:8080)
#
#   docker build -f infrastructure/docker/admin.Dockerfile -t vault-rush-admin .
#   docker run -p 8082:8082 -e API_UPSTREAM=http://host.docker.internal:8080 vault-rush-admin
#
# Build context is the repository root.

ARG NODE_VERSION=24
ARG NGINX_VERSION=1.27

# ---------- build stage ----------
FROM node:${NODE_VERSION}-alpine AS build

# Empty = same-origin; nginx proxies /admin/v1/* to the API.
ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}

WORKDIR /app

COPY admin/package.json admin/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY admin/ ./
RUN npm run build

# ---------- runtime stage ----------
FROM nginx:${NGINX_VERSION}-alpine

# API_UPSTREAM is substituted into the nginx config at container start by the image's
# envsubst entrypoint hook (20-envsubst-on-templates.sh). Override it per environment
# without rebuilding the image.
ENV LISTEN_PORT=8082 \
    API_UPSTREAM=http://api:8080 \
    NGINX_ENVSUBST_FILTER="^(LISTEN_PORT|API_UPSTREAM)$"

RUN rm -f /etc/nginx/conf.d/default.conf
COPY infrastructure/docker/nginx/admin.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8082

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${LISTEN_PORT}/_nginx/health || exit 1
