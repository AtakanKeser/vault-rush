output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "api_task_family" {
  value = aws_ecs_task_definition.api.family
}

output "worker_task_family" {
  value = aws_ecs_task_definition.worker.family
}

output "alb_arn" {
  value = aws_lb.api.arn
}

output "alb_arn_suffix" {
  value = aws_lb.api.arn_suffix
}

output "alb_dns_name" {
  value = aws_lb.api.dns_name
}

output "alb_zone_id" {
  value = aws_lb.api.zone_id
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "tasks_security_group_id" {
  value = aws_security_group.tasks.id
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "api_task_role_arn" {
  value = aws_iam_role.api_task.arn
}

output "worker_task_role_arn" {
  value = aws_iam_role.worker_task.arn
}

output "log_groups" {
  value = {
    api    = aws_cloudwatch_log_group.api.name
    worker = aws_cloudwatch_log_group.worker.name
  }
}
