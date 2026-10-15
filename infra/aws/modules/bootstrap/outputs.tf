# bootstrap/outputs.tf

output "bucket_name" {
  description = "Nombre del bucket S3 que almacena el estado remoto de OpenTofu/Terraform."
  value       = aws_s3_bucket.estado.bucket
}

output "bucket_arn" {
  description = "ARN del bucket S3 de estado remoto."
  value       = aws_s3_bucket.estado.arn
}

output "kms_key_arn" {
  description = "ARN de la llave KMS CMK que cifra el estado remoto."
  value       = aws_kms_key.estado.arn
}

output "kms_key_id" {
  description = "ID de la llave KMS CMK (sin prefijo 'arn:...'). Útil para configurar el backend S3 en otros módulos."
  value       = aws_kms_key.estado.key_id
}
