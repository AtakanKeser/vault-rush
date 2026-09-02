# One ECR repository per binary. Tags are mutable because the deploy workflow re-points
# `latest` on every release; the immutable identity of a release is its commit-SHA tag.

variable "name" {
  type = string
}

variable "repositories" {
  description = "Repository suffixes (one per image)."
  type        = set(string)
  default     = ["api", "worker"]
}

variable "keep_last_images" {
  description = "Tagged images to retain per repository (older ones are expired)."
  type        = number
  default     = 30
}

variable "untagged_expire_days" {
  description = "Days after which untagged (superseded) images are removed."
  type        = number
  default     = 7
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_ecr_repository" "this" {
  for_each = var.repositories

  name                 = "${var.name}-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after ${var.untagged_expire_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_expire_days
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last ${var.keep_last_images} images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.keep_last_images
        }
        action = { type = "expire" }
      },
    ]
  })
}

output "repository_urls" {
  description = "Map of suffix -> repository URL (registry/name)."
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "repository_arns" {
  value = { for k, r in aws_ecr_repository.this : k => r.arn }
}

output "repository_names" {
  value = { for k, r in aws_ecr_repository.this : k => r.name }
}
