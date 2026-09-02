locals {
  # "vault-rush-prod" — prefix for every named resource.
  name = "${var.project}-${var.environment}"

  tags = merge(
    {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "github.com/atakank/vault-rush"
    },
    var.tags,
  )

  # Environment consumed by both binaries (see docs/operations.md, "Environment variables").
  # DYNAMODB_ENDPOINT and SQS_ENDPOINT are deliberately absent: empty means "real AWS".
  # ADMIN_TOKEN and TOKEN_SECRET are injected as secrets, not environment.
  container_environment = merge(
    {
      ENV                = "production"
      PORT               = "8080"
      STORAGE            = "dynamodb"
      CACHE              = "redis"
      QUEUE              = "sqs"
      REDIS_ADDR         = "${module.data.redis_primary_endpoint}:${module.data.redis_port}"
      DYNAMODB_TABLE     = module.data.table_name
      AWS_REGION         = var.aws_region
      SQS_QUEUE_URL      = module.data.queue_url
      TELEMETRY_WORKERS  = tostring(var.telemetry_workers)
      TELEMETRY_BUFFER   = tostring(var.telemetry_buffer)
      RATE_LIMIT_PER_MIN = tostring(var.rate_limit_per_min)
      CORS_ORIGINS       = join(",", var.cors_origins)
      LOG_LEVEL          = var.log_level
    },
    var.extra_environment,
  )

  container_secrets = {
    ADMIN_TOKEN  = aws_ssm_parameter.admin_token.arn
    TOKEN_SECRET = aws_ssm_parameter.token_secret.arn
  }

  # The admin distribution forwards the API's admin surface to the ALB so the dashboard is
  # same-origin with the API (mirrors infrastructure/docker/nginx/admin.conf.template).
  # With a custom API domain CloudFront talks HTTPS to the ALB; without one it uses the raw
  # ALB hostname over HTTP (the ALB has no certificate to present in that case).
  api_origin_domain_name     = var.api_domain_name != "" ? var.api_domain_name : module.ecs.alb_dns_name
  api_origin_protocol_policy = var.api_domain_name != "" ? "https-only" : "http-only"

  static_sites = {
    client = {
      domain_names     = var.client_domain_names
      api_origin_paths = var.client_api_origin_paths
    }
    admin = {
      domain_names     = var.admin_domain_names
      api_origin_paths = ["/admin/*", "/healthz", "/readyz", "/metrics"]
    }
  }
}
