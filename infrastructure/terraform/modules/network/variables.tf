variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "vpc_cidr" {
  type = string
}

variable "az_count" {
  type    = number
  default = 2
}

variable "single_nat_gateway" {
  description = "One NAT gateway shared by all private subnets instead of one per AZ."
  type        = bool
  default     = true
}

variable "interface_endpoints" {
  description = "AWS services to expose through Interface VPC endpoints in the private subnets."
  type        = set(string)
  default     = ["sqs", "ecr.api", "ecr.dkr", "logs", "ssm"]
}

variable "tags" {
  type    = map(string)
  default = {}
}
