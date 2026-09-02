# Example production variables. Copy to environments/prod/terraform.tfvars (git-ignored)
# and replace the placeholders. Secrets are better supplied through the environment:
#
#   export TF_VAR_admin_token="$(openssl rand -hex 24)"
#   export TF_VAR_token_secret="$(openssl rand -hex 32)"
#
# then: make plan ENV=prod && make apply

project     = "vault-rush"
environment = "prod"
aws_region  = "eu-central-1"

# --- network --------------------------------------------------------------------------
vpc_cidr           = "10.40.0.0/16"
az_count           = 2
single_nat_gateway = true

# --- TLS / domains ------------------------------------------------------------------
# Leave all four empty for a first bootstrap without DNS: the ALB serves HTTP and the
# distributions use *.cloudfront.net hostnames. Add them once the certificates are issued.
api_acm_certificate_arn              = "arn:aws:acm:eu-central-1:123456789012:certificate/REPLACE-ME"
api_domain_name                      = "api.vault-rush.example.com"
static_acm_certificate_arn_us_east_1 = "arn:aws:acm:us-east-1:123456789012:certificate/REPLACE-ME"
client_domain_names                  = ["play.vault-rush.example.com"]
admin_domain_names                   = ["ops.vault-rush.example.com"]

# Browser origins allowed to call the API directly. The admin is same-origin through
# CloudFront and needs no entry here.
cors_origins = ["https://play.vault-rush.example.com"]

# Uncomment to make the player client same-origin too (CloudFront forwards /v1/* to the ALB).
# client_api_origin_paths = ["/v1/*"]

# --- sizing ---------------------------------------------------------------------------
cpu_architecture        = "X86_64"
api_cpu                 = 512
api_memory              = 1024
api_desired_count       = 2
api_min_count           = 2
api_max_count           = 10
api_cpu_target_percent  = 60
api_requests_per_target = 3000

worker_cpu                = 256
worker_memory             = 512
worker_desired_count      = 1
worker_min_count          = 1
worker_max_count          = 4
worker_queue_depth_target = 200

stop_timeout_seconds = 60

# --- data -----------------------------------------------------------------------------
dynamodb_table_name      = "vault_rush"
sqs_queue_name           = "vault-rush-events"
redis_node_type          = "cache.t4g.micro"
redis_num_nodes          = 1
redis_transit_encryption = false
deletion_protection      = true
log_retention_days       = 30

# SNS topics for alarms (DLQ not empty, ALB 5xx, unhealthy targets).
alarm_actions = []

# --- application ----------------------------------------------------------------------
telemetry_workers  = 8
telemetry_buffer   = 1000
rate_limit_per_min = 100
log_level          = "info"

extra_environment = {}

# Secrets: prefer TF_VAR_* (see header). Never commit real values.
# admin_token  = "REPLACE-ME"
# token_secret = "REPLACE-ME-WITH-AT-LEAST-32-CHARACTERS"
