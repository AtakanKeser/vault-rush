# Single-table design. All entities share one table and are distinguished by key prefixes
# (docs/architecture.md, "Data model"):
#
#   PK                        SK               item
#   PLAYER#<playerId>         PROFILE          profile + optimistic-concurrency version
#   PLAYER#<playerId>         RUN#<runId>      heist run (seed, configVersion, boosters, status)
#   PLAYER#<playerId>         REWARD#<id>      reward, PENDING -> CLAIMED via conditional write
#   DEVICE#<deviceId>         PLAYER           deviceId -> playerId
#   EVENT#<eventId>           META             event metadata (GSI1PK=EVENT, GSI1SK=startsAt)
#   EVENT#<eventId>           CONFIG#00017     immutable config version
#   IDEMP#<playerId>#<key>    RESPONSE         stored finish response (ttl)
#
# On-demand billing: traffic is spiky (daily event resets) and the MVP has no baseline
# worth reserving capacity for. PITR covers operator mistakes; the same schema is created
# locally by infrastructure/docker/dynamodb/create-table.sh.

resource "aws_dynamodb_table" "this" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  table_class  = "STANDARD"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  # Epoch-seconds attribute set on IDEMP#… items and finished RUN#… items.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true # AWS-owned key; switch to a CMK by adding kms_key_arn
  }

  deletion_protection_enabled = var.deletion_protection

  tags = merge(var.tags, { Name = var.table_name })
}
