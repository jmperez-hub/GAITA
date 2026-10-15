# backups-bucket/outputs.tf

output "bucket_id" {
  description = "Nombre (ID) del bucket S3 de respaldos"
  value       = aws_s3_bucket.respaldos.id
}

output "bucket_arn" {
  description = "ARN del bucket S3 de respaldos"
  value       = aws_s3_bucket.respaldos.arn
}

output "bucket_domain_name" {
  description = "Nombre de dominio regional del bucket (para configurar clientes S3)"
  value       = aws_s3_bucket.respaldos.bucket_regional_domain_name
}
