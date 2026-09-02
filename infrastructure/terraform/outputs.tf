# Values consumed by .github/workflows/deploy.yml (as repository variables) and by the runbook.

output "api_url" {
  description = "Base URL of the API."
  value       = var.api_domain_name != "" ? "https://${var.api_domain_name}" : "http://${module.ecs.alb_dns_name}"
}

output "alb_dns_name" {
  description = "ALB hostname; point api_domain_name at this (CNAME/ALIAS)."
  value       = module.ecs.alb_dns_name
}

output "alb_zone_id" {
  value = module.ecs.alb_zone_id
}

output "ecs_cluster" {
  description = "ECS_CLUSTER"
  value       = module.ecs.cluster_name
}

output "ecs_service_api" {
  description = "ECS_SERVICE_API"
  value       = module.ecs.api_service_name
}

output "ecs_service_worker" {
  description = "ECS_SERVICE_WORKER"
  value       = module.ecs.worker_service_name
}

output "ecr_repository_api" {
  description = "ECR_REPOSITORY_API (name)"
  value       = module.ecr.repository_names["api"]
}

output "ecr_repository_worker" {
  description = "ECR_REPOSITORY_WORKER (name)"
  value       = module.ecr.repository_names["worker"]
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "dynamodb_table_name" {
  value = module.data.table_name
}

output "sqs_queue_url" {
  value = module.data.queue_url
}

output "sqs_dlq_url" {
  value = module.data.dlq_url
}

output "redis_endpoint" {
  value = "${module.data.redis_primary_endpoint}:${module.data.redis_port}"
}

output "client_bucket" {
  description = "CLIENT_BUCKET"
  value       = module.static["client"].bucket_name
}

output "client_distribution_id" {
  description = "CLIENT_DISTRIBUTION_ID"
  value       = module.static["client"].distribution_id
}

output "client_url" {
  value = module.static["client"].url
}

output "admin_bucket" {
  description = "ADMIN_BUCKET"
  value       = module.static["admin"].bucket_name
}

output "admin_distribution_id" {
  description = "ADMIN_DISTRIBUTION_ID"
  value       = module.static["admin"].distribution_id
}

output "admin_url" {
  value = module.static["admin"].url
}

output "cloudfront_domain_names" {
  description = "Default *.cloudfront.net hostnames; CNAME custom domains to these."
  value = {
    client = module.static["client"].distribution_domain_name
    admin  = module.static["admin"].distribution_domain_name
  }
}

output "log_groups" {
  value = module.ecs.log_groups
}

output "github_actions_variables" {
  description = "Copy these into the GitHub `production` environment variables."
  value = {
    AWS_REGION             = var.aws_region
    ECS_CLUSTER            = module.ecs.cluster_name
    ECS_SERVICE_API        = module.ecs.api_service_name
    ECS_SERVICE_WORKER     = module.ecs.worker_service_name
    ECR_REPOSITORY_API     = module.ecr.repository_names["api"]
    ECR_REPOSITORY_WORKER  = module.ecr.repository_names["worker"]
    CLIENT_BUCKET          = module.static["client"].bucket_name
    CLIENT_DISTRIBUTION_ID = module.static["client"].distribution_id
    CLIENT_API_URL         = var.api_domain_name != "" ? "https://${var.api_domain_name}" : "http://${module.ecs.alb_dns_name}"
    ADMIN_BUCKET           = module.static["admin"].bucket_name
    ADMIN_DISTRIBUTION_ID  = module.static["admin"].distribution_id
    ADMIN_API_URL          = "" # same-origin: CloudFront forwards /admin/* to the API
  }
}
