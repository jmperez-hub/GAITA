# kms/outputs.tf

# --- Llave plataforma ---

output "plataforma_key_id" {
  description = "ID de la llave KMS de plataforma"
  value       = aws_kms_key.plataforma.key_id
}

output "plataforma_key_arn" {
  description = "ARN de la llave KMS de plataforma"
  value       = aws_kms_key.plataforma.arn
}

output "plataforma_alias_arn" {
  description = "ARN del alias de la llave KMS de plataforma"
  value       = aws_kms_alias.plataforma.arn
}

# --- Llave respaldos ---

output "respaldos_key_id" {
  description = "ID de la llave KMS de respaldos"
  value       = aws_kms_key.respaldos.key_id
}

output "respaldos_key_arn" {
  description = "ARN de la llave KMS de respaldos"
  value       = aws_kms_key.respaldos.arn
}

output "respaldos_alias_arn" {
  description = "ARN del alias de la llave KMS de respaldos"
  value       = aws_kms_alias.respaldos.arn
}

# --- Llave datos-salud ---

output "datos_salud_key_id" {
  description = "ID de la llave KMS de datos de salud"
  value       = aws_kms_key.datos_salud.key_id
  sensitive   = true
}

output "datos_salud_key_arn" {
  description = "ARN de la llave KMS de datos de salud"
  value       = aws_kms_key.datos_salud.arn
  sensitive   = true
}

output "datos_salud_alias_arn" {
  description = "ARN del alias de la llave KMS de datos de salud"
  value       = aws_kms_alias.datos_salud.arn
  sensitive   = true
}
