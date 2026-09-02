variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "table_name" {
  type    = string
  default = "vault_rush"
}

variable "queue_name" {
  type    = string
  default = "vault-rush-events"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "redis_num_nodes" {
  type    = number
  default = 1

  validation {
    condition     = var.redis_num_nodes >= 1 && var.redis_num_nodes <= 5
    error_message = "redis_num_nodes must be between 1 and 5."
  }
}

variable "redis_engine_version" {
  type    = string
  default = "7.1"
}

variable "redis_transit_encryption" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "alarm_actions" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
