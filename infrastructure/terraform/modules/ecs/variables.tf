variable "name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "acm_certificate_arn" {
  description = "Certificate for the HTTPS listener. Empty = HTTP-only ALB."
  type        = string
  default     = ""
}

variable "alb_ingress_cidrs" {
  description = "CIDRs allowed to reach the ALB."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "container_insights" {
  type    = bool
  default = true
}

variable "cpu_architecture" {
  type    = string
  default = "X86_64"
}

# ---- images -------------------------------------------------------------------------

variable "api_image" {
  type = string
}

variable "worker_image" {
  type = string
}

# ---- api sizing / scaling ---------------------------------------------------------

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "api_min_count" {
  type    = number
  default = 2
}

variable "api_max_count" {
  type    = number
  default = 10
}

variable "api_cpu_target" {
  description = "Target CPU utilisation (%) for API target tracking."
  type        = number
  default     = 60
}

variable "api_requests_target" {
  description = "Target ALB RequestCountPerTarget (per minute) for API target tracking."
  type        = number
  default     = 3000
}

# ---- worker sizing / scaling -----------------------------------------------------

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

variable "worker_queue_target" {
  description = "Target ApproximateNumberOfMessagesVisible for worker target tracking."
  type        = number
  default     = 200
}

variable "stop_timeout_seconds" {
  type    = number
  default = 60

  validation {
    condition     = var.stop_timeout_seconds >= 2 && var.stop_timeout_seconds <= 120
    error_message = "Fargate allows stopTimeout between 2 and 120 seconds."
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}

# ---- configuration -----------------------------------------------------------------

variable "environment" {
  description = "Plain environment variables for both containers."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secret environment variables: name -> SSM parameter / Secrets Manager ARN."
  type        = map(string)
  default     = {}
}

# ---- dependencies (for IAM and security groups) --------------------------------

variable "dynamodb_table_arn" {
  type = string
}

variable "sqs_queue_arn" {
  type = string
}

variable "sqs_queue_name" {
  type = string
}

variable "sqs_dlq_arn" {
  type = string
}

variable "redis_security_group_id" {
  description = "Security group of the Redis replication group; an ingress rule from the tasks SG is added here."
  type        = string
}

variable "alarm_actions" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
