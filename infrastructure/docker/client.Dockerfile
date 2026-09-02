# syntax=docker/dockerfile:1
#
# Vault Rush — player client (Vite + TypeScript + HTML5 Canvas), served as static files by nginx.
#
#   docker build -f infrastructure/docker/client.Dockerfile -t vault-rush-client .
#   docker run -p 8081:8081 -e API_URL=http://localhost:8080 vault-rush-client
#
# Build context is the repository root.

ARG NODE_VERSION=24
ARG NGINX_VERSION=1.27

# ---------- build stage ----------
FROM node:${NODE_VERSION}-alpine AS build

# Vite inlines VITE_* variables at build time. The API base URL defaults to same-origin
# (empty) so the client works behind any reverse proxy; override for a split deployment.
ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}

WORKDIR /app

COPY client/package.json client/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY client/ ./
RUN npm run build

# ---------- runtime stage ----------
FROM nginx:${NGINX_VERSION}-alpine

# The nginx image renders /etc/nginx/templates/*.template with envsubst on startup and
# writes the result to /etc/nginx/conf.d/. Only the variables listed in
# NGINX_ENVSUBST_FILTER are substituted, so nginx's own $uri/$host variables survive.
ENV LISTEN_PORT=8081 \
    API_UPSTREAM=http://api:8080 \
    NGINX_ENVSUBST_FILTER="^(LISTEN_PORT|API_UPSTREAM)$"

RUN rm -f /etc/nginx/conf.d/default.conf
COPY infrastructure/docker/nginx/client.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${LISTEN_PORT}/_nginx/health || exit 1
