output "bucket_name" {
  description = "Nombre del bucket S3 que almacena los logs de CloudTrail"
  value       = aws_s3_bucket.cloudtrail.id
}

output "bucket_arn" {
  description = "ARN del bucket S3 de CloudTrail"
  value       = aws_s3_bucket.cloudtrail.arn
}

output "trail_arn" {
  description = "ARN del trail organizacional de CloudTrail"
  value       = aws_cloudtrail.org.arn
}

output "trail_home_region" {
  description = "Región principal del trail de CloudTrail"
  value       = aws_cloudtrail.org.home_region
}
