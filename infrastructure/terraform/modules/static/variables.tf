variable "name" {
  type = string
}

variable "site" {
  description = "Site identifier used in resource names (client | admin)."
  type        = string
}

variable "bucket_name" {
  description = "Explicit bucket name. Empty = <name>-<site>-<account-id>."
  type        = string
  default     = ""
}

variable "domain_names" {
  description = "Alternate domain names (CNAMEs) for the distribution. Requires acm_certificate_arn."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM certificate in us-east-1 covering domain_names."
  type        = string
  default     = ""
}

variable "api_origin_domain_name" {
  description = "Hostname of the API to forward api_origin_paths to. Empty = no API origin."
  type        = string
  default     = ""
}

variable "api_origin_protocol_policy" {
  description = "How CloudFront connects to the API origin: https-only (custom domain with certificate) or http-only (raw ALB hostname)."
  type        = string
  default     = "https-only"

  validation {
    condition     = contains(["https-only", "http-only", "match-viewer"], var.api_origin_protocol_policy)
    error_message = "api_origin_protocol_policy must be https-only, http-only or match-viewer."
  }
}

variable "api_origin_paths" {
  description = "Path patterns routed to the API origin instead of S3."
  type        = list(string)
  default     = []
}

variable "price_class" {
  type    = string
  default = "PriceClass_100" # North America + Europe
}

variable "tags" {
  type    = map(string)
  default = {}
}
