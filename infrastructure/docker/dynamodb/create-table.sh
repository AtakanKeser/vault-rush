#!/usr/bin/env bash
#
# Create the Vault Rush single table on DynamoDB Local (idempotent).
#
# Usage:
#   ./infrastructure/docker/dynamodb/create-table.sh
#   DYNAMODB_ENDPOINT=http://dynamodb:8000 ./create-table.sh      # from inside the compose network
#
# Requires the AWS CLI. DynamoDB Local accepts any static credentials; the region only
# namespaces the local data file. In CI this runs against the amazon/dynamodb-local
# service container; in production the same schema is owned by Terraform
# (infrastructure/terraform/modules/data/dynamodb.tf) and this script is never used.
#
# ---------------------------------------------------------------------------------------
# Table schema: single-table design, on-demand billing.
#
#   Table  vault_rush
#     PK   (S)  hash   partition key
#     SK   (S)  range  sort key
#   GSI1   GSI1PK (S) hash, GSI1SK (S) range, projection ALL
#   TTL    attribute "ttl" (epoch seconds) — used by IDEMP#… and expired RUN#… items
#
#   Key patterns (see docs/architecture.md, "Data model"):
#     PLAYER#<playerId>        / PROFILE                 player profile, version counter
#     PLAYER#<playerId>        / RUN#<runId>             heist run (seed, configVersion, status)
#     PLAYER#<playerId>        / REWARD#<rewardId>       reward, PENDING -> CLAIMED
#     DEVICE#<deviceId>        / PLAYER                  device -> playerId lookup
#     EVENT#<eventId>          / META                    event metadata
#     EVENT#<eventId>          / CONFIG#00017            immutable config version (zero-padded)
#     IDEMP#<playerId>#<key>   / RESPONSE                stored finish response (TTL)
#     GSI1PK = EVENT, GSI1SK = <startsAt ISO-8601>       list events by date
# ---------------------------------------------------------------------------------------

set -euo pipefail

ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:8000}"
TABLE="${DYNAMODB_TABLE:-vault_rush}"
REGION="${AWS_REGION:-eu-central-1}"
WAIT_SECONDS="${WAIT_SECONDS:-60}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_PAGER=""

aws_ddb() {
  aws dynamodb "$@" --endpoint-url "$ENDPOINT" --region "$REGION"
}

log() { printf '[create-table] %s\n' "$*" >&2; }

if ! command -v aws >/dev/null 2>&1; then
  log "aws CLI not found in PATH"
  exit 1
fi

# Wait for DynamoDB Local to accept connections (compose may start us first).
log "waiting for DynamoDB at $ENDPOINT (up to ${WAIT_SECONDS}s)"
deadline=$((SECONDS + WAIT_SECONDS))
until aws_ddb list-tables >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    log "DynamoDB endpoint $ENDPOINT not reachable after ${WAIT_SECONDS}s"
    exit 1
  fi
  sleep 1
done

if aws_ddb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  log "table '$TABLE' already exists at $ENDPOINT — nothing to do"
  exit 0
fi

log "creating table '$TABLE'"
aws_ddb create-table \
  --table-name "$TABLE" \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
      AttributeName=PK,AttributeType=S \
      AttributeName=SK,AttributeType=S \
      AttributeName=GSI1PK,AttributeType=S \
      AttributeName=GSI1SK,AttributeType=S \
  --key-schema \
      AttributeName=PK,KeyType=HASH \
      AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes '[
    {
      "IndexName": "GSI1",
      "KeySchema": [
        { "AttributeName": "GSI1PK", "KeyType": "HASH" },
        { "AttributeName": "GSI1SK", "KeyType": "RANGE" }
      ],
      "Projection": { "ProjectionType": "ALL" }
    }
  ]' >/dev/null

aws_ddb wait table-exists --table-name "$TABLE"

# TTL for idempotency records and expired runs. DynamoDB Local accepts the call; actual
# expiry sweeps are only performed by the real service.
aws_ddb update-time-to-live \
  --table-name "$TABLE" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null || \
  log "warning: could not enable TTL (non-fatal on DynamoDB Local)"

log "table '$TABLE' ready"
aws_ddb describe-table --table-name "$TABLE" \
  --query 'Table.{Name:TableName,Status:TableStatus,Keys:KeySchema,GSIs:GlobalSecondaryIndexes[].IndexName}' \
  --output table >&2
