# ---------------------------------------------------------------------------------------
# Naming and placement
# ---------------------------------------------------------------------------------------

variable "project" {
  description = "Project slug used as a prefix for every resource name."
  type        = string
  default     = "vault-rush"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.project))
    error_message = "project must be lowercase alphanumeric/hyphens, 2-21 chars (it prefixes ALB and ElastiCache names with tight length limits)."
  }
}

variable "environment" {
  description = "Environment name (prod, staging, ...). Part of every resource name."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.environment))
    error_message = "environment must be short lowercase alphanumeric (2-10 chars)."
  }
}

variable "aws_region" {
  description = "AWS region for all regional resources (matches AWS_REGION consumed by the services)."
  type        = string
  default     = "eu-central-1"
}

variable "tags" {
  description = "Extra tags merged into the default tags applied to every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "VPC CIDR. Subnets are carved as /20s from it (2 public + 2 private for az_count = 2)."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones (public + private subnet per AZ)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "Use one NAT gateway for all private subnets (cheaper, loses AZ redundancy for egress). Most egress goes through VPC endpoints anyway."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------------------
# TLS and domains
# ---------------------------------------------------------------------------------------

variable "api_acm_certificate_arn" {
  description = "ACM certificate ARN (in aws_region) for the API ALB HTTPS listener. Empty = HTTP-only listener (bootstrap / no domain yet)."
  type        = string
  default     = ""
}

variable "api_domain_name" {
  description = "Public DNS name of the API (must resolve to the ALB). Required when api_acm_certificate_arn is set; used as the CloudFront origin for the admin distribution."
  type        = string
  default     = ""
}

variable "static_acm_certificate_arn_us_east_1" {
  description = "ACM certificate ARN in us-east-1 covering client_domain_names and admin_domain_names. Empty = CloudFront default certificate and *.cloudfront.net hostnames."
  type        = string
  default     = ""
}

variable "client_domain_names" {
  description = "Alternate domain names for the player client distribution."
  type        = list(string)
  default     = []
}

variable "admin_domain_names" {
  description = "Alternate domain names for the LiveOps admin distribution."
  type        = list(string)
  default     = []
}

variable "client_api_origin_paths" {
  description = "Path patterns on the client distribution to forward to the API (e.g. [\"/v1/*\"] for a same-origin client). Empty = the client calls the API directly (CORS)."
  type        = list(string)
  default     = []
}

variable "cors_origins" {
  description = "Allowed browser origins for the API (CORS_ORIGINS). Narrow this to the client/admin hostnames once they are known."
  type        = list(string)
  default     = ["*"]
}

# ---------------------------------------------------------------------------------------
# Images and sizing
# ---------------------------------------------------------------------------------------

variable "image_tag" {
  description = "Image tag used when Terraform (re)creates the task definitions. The deploy workflow overrides the image with the commit SHA on every deploy."
  type        = string
  default     = "latest"
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture. Must match the platform the images were built for (deploy.yml builds linux/amd64)."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "api_cpu" {
  description = "API task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "API task memory (MiB). Must be a valid Fargate combination with api_cpu."
  type        = number
  default     = 1024
}

variable "api_desired_count" {
  description = "Initial API task count (autoscaling takes over afterwards)."
  type        = number
  default     = 2
}

variable "api_min_count" {
  type    = number
  default = 2
}

variable "api_max_count" {
  type    = number
  default = 10
}

variable "api_cpu_target_percent" {
  description = "Target-tracking CPU utilisation for the API service."
  type        = number
  default     = 60
}

variable "api_requests_per_target" {
  description = "Target-tracking ALB requests per target per minute for the API service."
  type        = number
  default     = 3000
}

variable "worker_cpu" {
  type    = number
  default = 256
}

variable "worker_memory" {
  type    = number
  default = 512
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "worker_min_count" {
  type    = number
  default = 1
}

variable "worker_max_count" {
  type    = number
  default = 4
}

variable "worker_queue_depth_target" {
  description = "Target-tracking ApproximateNumberOfMessagesVisible on the events queue per worker task."
  type        = number
  default     = 200
}

variable "stop_timeout_seconds" {
  description = "Seconds ECS waits between SIGTERM and SIGKILL. Must exceed the API's graceful drain (in-flight requests + telemetry channel). Fargate max is 120."
  type        = number
  default     = 60
}

# ---------------------------------------------------------------------------------------
# Data stores
# ---------------------------------------------------------------------------------------

variable "dynamodb_table_name" {
  description = "Single-table name (DYNAMODB_TABLE). Kept environment-agnostic because one AWS account hosts one environment."
  type        = string
  default     = "vault_rush"
}

variable "sqs_queue_name" {
  description = "Events queue name (the DLQ is <name>-dlq)."
  type        = string
  default     = "vault-rush-events"
}

variable "redis_node_type" {
  description = "ElastiCache node type. cache.t4g.micro is enough for the MVP leaderboard; scale vertically first, sorted sets are single-key."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_num_nodes" {
  description = "Cache clusters in the replication group. 1 = single node (no failover); 2+ enables automatic failover and Multi-AZ."
  type        = number
  default     = 1
}

variable "redis_transit_encryption" {
  description = "Enable TLS on Redis. Requires the Go client to dial with TLS (REDIS_ADDR stays host:port)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Deletion protection on the DynamoDB table and the ALB."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "alarm_actions" {
  description = "SNS topic ARNs notified by CloudWatch alarms (DLQ not empty, ALB 5xx, unhealthy targets)."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------------------
# Application configuration
# ---------------------------------------------------------------------------------------

variable "admin_token" {
  description = "Value of ADMIN_TOKEN, stored as an SSM SecureString and injected as a container secret. Prefer TF_VAR_admin_token over a tfvars file."
  type        = string
  sensitive   = true
}

variable "token_secret" {
  description = "Value of TOKEN_SECRET (player bearer token signing key). Same handling as admin_token."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.token_secret) >= 32
    error_message = "token_secret must be at least 32 characters."
  }
}

variable "telemetry_workers" {
  type    = number
  default = 8
}

variable "telemetry_buffer" {
  type    = number
  default = 1000
}

variable "rate_limit_per_min" {
  type    = number
  default = 100
}

variable "log_level" {
  type    = string
  default = "info"
}

variable "extra_environment" {
  description = "Additional environment variables for both containers (merged last, so they override the computed defaults)."
  type        = map(string)
  default     = {}
}
