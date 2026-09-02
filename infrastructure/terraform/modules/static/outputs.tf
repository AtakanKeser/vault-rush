output "bucket_name" {
  value = aws_s3_bucket.site.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.site.arn
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.site.arn
}

output "distribution_domain_name" {
  value = aws_cloudfront_distribution.site.domain_name
}

output "distribution_hosted_zone_id" {
  description = "Route 53 alias target zone for CloudFront."
  value       = aws_cloudfront_distribution.site.hosted_zone_id
}

output "url" {
  value = local.use_custom_domain ? "https://${var.domain_names[0]}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}
