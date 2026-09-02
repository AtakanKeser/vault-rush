# Vault Rush — production stack.
#
#   network  VPC, subnets, NAT, VPC endpoints
#   ecr      image repositories for api and worker
#   data     DynamoDB single table, ElastiCache Redis, SQS queue + DLQ
#   ecs      Fargate cluster, ALB, api + worker services, autoscaling, IAM
#   static   S3 + CloudFront for the player client and the LiveOps admin
#
# Dependency order: network -> (ecr, data) -> ecs -> static (the admin distribution needs
# the ALB hostname as an origin). CORS_ORIGINS is a plain variable rather than a reference
# to the CloudFront hostnames precisely to avoid the ecs <-> static cycle.

# ---------------------------------------------------------------------------------------
# Guards for combinations that individual variable validations cannot express.
# ---------------------------------------------------------------------------------------

resource "terraform_data" "config_guard" {
  lifecycle {
    precondition {
      condition     = (var.api_acm_certificate_arn == "") == (var.api_domain_name == "")
      error_message = "api_acm_certificate_arn and api_domain_name must be set together: with a certificate the ALB redirects HTTP to HTTPS, so CloudFront must reach it through the certificate's hostname."
    }
    precondition {
      condition     = var.static_acm_certificate_arn_us_east_1 != "" || (length(var.client_domain_names) == 0 && length(var.admin_domain_names) == 0)
      error_message = "client_domain_names/admin_domain_names require static_acm_certificate_arn_us_east_1."
    }
    precondition {
      condition     = var.api_min_count <= var.api_desired_count && var.api_desired_count <= var.api_max_count
      error_message = "api_min_count <= api_desired_count <= api_max_count must hold."
    }
  }
}

# ---------------------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------------------

module "network" {
  source = "./modules/network"

  name               = local.name
  vpc_cidr           = var.vpc_cidr
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
  tags               = local.tags
}

# ---------------------------------------------------------------------------------------
# Container registry
# ---------------------------------------------------------------------------------------

module "ecr" {
  source = "./modules/ecr"

  name         = local.name
  repositories = ["api", "worker"]
  tags         = local.tags
}

# ---------------------------------------------------------------------------------------
# Data stores
# ---------------------------------------------------------------------------------------

module "data" {
  source = "./modules/data"

  name                     = local.name
  vpc_id                   = module.network.vpc_id
  private_subnet_ids       = module.network.private_subnet_ids
  table_name               = var.dynamodb_table_name
  queue_name               = var.sqs_queue_name
  redis_node_type          = var.redis_node_type
  redis_num_nodes          = var.redis_num_nodes
  redis_transit_encryption = var.redis_transit_encryption
  deletion_protection      = var.deletion_protection
  alarm_actions            = var.alarm_actions
  tags                     = local.tags
}

# ---------------------------------------------------------------------------------------
# Secrets: SSM SecureString parameters, referenced by ARN from the task definitions and
# decrypted by the ECS agent at task start. Values never appear in the task definition.
# Rotation: `aws ssm put-parameter --overwrite` then force a new deployment
# (docs/operations.md, "Rotating ADMIN_TOKEN").
# ---------------------------------------------------------------------------------------

resource "aws_ssm_parameter" "admin_token" {
  name        = "/${var.project}/${var.environment}/ADMIN_TOKEN"
  description = "X-Admin-Token for the LiveOps API"
  type        = "SecureString"
  value       = var.admin_token
  tier        = "Standard"

  lifecycle {
    # Rotated out-of-band; Terraform must not revert a rotation on the next apply.
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "token_secret" {
  name        = "/${var.project}/${var.environment}/TOKEN_SECRET"
  description = "Signing key for player bearer tokens"
  type        = "SecureString"
  value       = var.token_secret
  tier        = "Standard"

  lifecycle {
    ignore_changes = [value]
  }
}

# ---------------------------------------------------------------------------------------
# Compute
# ---------------------------------------------------------------------------------------

module "ecs" {
  source = "./modules/ecs"

  name               = local.name
  aws_region         = var.aws_region
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  acm_certificate_arn = var.api_acm_certificate_arn
  deletion_protection = var.deletion_protection

  api_image    = "${module.ecr.repository_urls["api"]}:${var.image_tag}"
  worker_image = "${module.ecr.repository_urls["worker"]}:${var.image_tag}"

  cpu_architecture     = var.cpu_architecture
  api_cpu              = var.api_cpu
  api_memory           = var.api_memory
  api_desired_count    = var.api_desired_count
  api_min_count        = var.api_min_count
  api_max_count        = var.api_max_count
  api_cpu_target       = var.api_cpu_target_percent
  api_requests_target  = var.api_requests_per_target
  worker_cpu           = var.worker_cpu
  worker_memory        = var.worker_memory
  worker_desired_count = var.worker_desired_count
  worker_min_count     = var.worker_min_count
  worker_max_count     = var.worker_max_count
  worker_queue_target  = var.worker_queue_depth_target
  stop_timeout_seconds = var.stop_timeout_seconds
  log_retention_days   = var.log_retention_days

  environment = local.container_environment
  secrets     = local.container_secrets

  dynamodb_table_arn      = module.data.table_arn
  sqs_queue_arn           = module.data.queue_arn
  sqs_queue_name          = module.data.queue_name
  sqs_dlq_arn             = module.data.dlq_arn
  redis_security_group_id = module.data.redis_security_group_id

  alarm_actions = var.alarm_actions
  tags          = local.tags
}

# ---------------------------------------------------------------------------------------
# Static sites
# ---------------------------------------------------------------------------------------

module "static" {
  source   = "./modules/static"
  for_each = local.static_sites

  name                       = local.name
  site                       = each.key
  domain_names               = each.value.domain_names
  acm_certificate_arn        = var.static_acm_certificate_arn_us_east_1
  api_origin_domain_name     = length(each.value.api_origin_paths) > 0 ? local.api_origin_domain_name : ""
  api_origin_protocol_policy = local.api_origin_protocol_policy
  api_origin_paths           = each.value.api_origin_paths
  tags                       = local.tags
}
