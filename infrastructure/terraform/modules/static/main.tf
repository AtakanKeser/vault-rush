# Static SPA hosting: private S3 bucket + CloudFront with Origin Access Control.
#
# SPA routing is handled by a CloudFront Function on viewer-request that rewrites
# extension-less paths to /index.html — only for the S3 behaviour. This is deliberately
# not done with custom_error_response (403/404 -> index.html), because error responses
# apply to every behaviour and would turn the API's 403 FORBIDDEN / 404 RUN_NOT_FOUND
# into a 200 with the SPA shell when API paths are routed through the same distribution.

data "aws_caller_identity" "current" {}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "Managed-SecurityHeadersPolicy"
}

locals {
  bucket_name       = var.bucket_name != "" ? var.bucket_name : "${var.name}-${var.site}-${data.aws_caller_identity.current.account_id}"
  s3_origin_id      = "s3-${var.site}"
  api_origin_id     = "api"
  api_enabled       = var.api_origin_domain_name != "" && length(var.api_origin_paths) > 0
  use_custom_domain = length(var.domain_names) > 0 && var.acm_certificate_arn != ""
}

# ---------------------------------------------------------------------------------------
# Bucket
# ---------------------------------------------------------------------------------------

resource "aws_s3_bucket" "site" {
  bucket        = local.bucket_name
  force_destroy = false

  tags = merge(var.tags, { Name = local.bucket_name, Site = var.site })
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioning makes "roll back index.html to the previous deploy" a one-liner.
resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.site]
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# ---------------------------------------------------------------------------------------
# CloudFront
# ---------------------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-${var.site}"
  description                       = "OAC for ${local.bucket_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${var.name}-${var.site}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Serve index.html for extension-less paths (SPA client-side routing)"
  publish = true

  code = <<-JS
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      var last = uri.substring(uri.lastIndexOf('/') + 1);
      // Files (main-abc123.js, favicon.svg, ...) pass through; routes get the SPA shell.
      if (last === '' || last.indexOf('.') === -1) {
        request.uri = '/index.html';
      }
      return request;
    }
  JS
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.name} ${var.site}"
  default_root_object = "index.html"
  price_class         = var.price_class
  http_version        = "http2and3"
  aliases             = local.use_custom_domain ? var.domain_names : []

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  dynamic "origin" {
    for_each = local.api_enabled ? [1] : []
    content {
      domain_name = var.api_origin_domain_name
      origin_id   = local.api_origin_id

      custom_origin_config {
        http_port                = 80
        https_port               = 443
        origin_protocol_policy   = var.api_origin_protocol_policy
        origin_ssl_protocols     = ["TLSv1.2"]
        origin_read_timeout      = 30
        origin_keepalive_timeout = 5
      }
    }
  }

  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  # API paths: no caching, forward everything (headers, query, cookies) except Host.
  dynamic "ordered_cache_behavior" {
    for_each = local.api_enabled ? toset(var.api_origin_paths) : toset([])
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = local.api_origin_id
      viewer_protocol_policy   = "https-only"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.use_custom_domain
    acm_certificate_arn            = local.use_custom_domain ? var.acm_certificate_arn : null
    ssl_support_method             = local.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }

  tags = merge(var.tags, { Name = "${var.name}-${var.site}", Site = var.site })
}
