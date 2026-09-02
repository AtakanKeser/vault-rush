# Fargate cluster shared by the api and worker services.

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/${var.name}/api"
  retention_in_days = var.log_retention_days

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/${var.name}/worker"
  retention_in_days = var.log_retention_days

  tags = var.tags
}

locals {
  https_enabled = var.acm_certificate_arn != ""

  # Sorted by key (Terraform map iteration order) so the rendered JSON is stable.
  container_environment = [for k, v in var.environment : { name = k, value = v }]
  container_secrets     = [for k, v in var.secrets : { name = k, valueFrom = v }]

  common_container_settings = {
    essential              = true
    readonlyRootFilesystem = true # distroless static binary; nothing is written to disk
    stopTimeout            = var.stop_timeout_seconds
    environment            = local.container_environment
    secrets                = local.container_secrets
    ulimits = [
      { name = "nofile", softLimit = 65536, hardLimit = 65536 },
    ]
  }
}
