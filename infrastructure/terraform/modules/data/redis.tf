# ElastiCache for Redis — leaderboard sorted sets, rate-limit buckets, hot config cache.
#
# Cluster mode is off: the leaderboard for one event is a single sorted set, which cannot
# be sharded anyway, and a single node on cache.t4g.micro serves far more ZADD/ZRANK than
# the MVP needs. Set redis_num_nodes = 2 for a replica with automatic failover.
#
# Redis is treated as reconstructable state: every finished run is persisted in DynamoDB
# first, and the worker rebuilds an event's sorted set from RUN# items if the cache is
# lost (docs/architecture.md, "Fault tolerance").

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.name}-redis"
  subnet_ids = var.private_subnet_ids

  tags = var.tags
}

# Ingress rules are attached by the ecs module (tasks SG -> 6379) to keep this module
# independent of the compute layer.
resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "ElastiCache Redis; ingress granted per client security group"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name}-redis" })
}

resource "aws_elasticache_parameter_group" "redis" {
  name        = "${var.name}-redis7"
  family      = "redis7"
  description = "Vault Rush Redis 7 parameters"

  # Fail loudly instead of silently evicting leaderboard keys under memory pressure:
  # a failed ZADD surfaces in /metrics (sink retries) and alarms; an evicted ranking does not.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  tags = var.tags
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${var.name}-redis"
  description          = "Vault Rush leaderboard and cache"

  engine               = "redis"
  engine_version       = var.redis_engine_version
  node_type            = var.redis_node_type
  num_cache_clusters   = var.redis_num_nodes
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.redis.name
  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = [aws_security_group.redis.id]

  automatic_failover_enabled = var.redis_num_nodes > 1
  multi_az_enabled           = var.redis_num_nodes > 1

  at_rest_encryption_enabled = true
  transit_encryption_enabled = var.redis_transit_encryption

  snapshot_retention_limit = 1
  snapshot_window          = "03:00-04:00"
  maintenance_window       = "sun:04:00-sun:05:00"
  apply_immediately        = false

  tags = merge(var.tags, { Name = "${var.name}-redis" })
}

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name          = "${var.name}-redis-memory-high"
  alarm_description   = "Redis used memory above 80% — with noeviction, writes will start failing."
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.redis.id
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions

  tags = var.tags
}
