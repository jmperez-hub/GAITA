output "sso_instance_arn" {
  description = "ARN de la instancia de IAM Identity Center"
  value       = local.sso_instance_arn
}

output "sso_instance_id" {
  description = "ID del Identity Store de IAM Identity Center"
  value       = local.sso_instance_id
}

output "admin_plataforma_arn" {
  description = "ARN del permission set AdministradorPlataforma"
  value       = aws_ssoadmin_permission_set.admin_plataforma.arn
}

output "desarrollador_lectura_arn" {
  description = "ARN del permission set DesarrolladorLectura"
  value       = aws_ssoadmin_permission_set.desarrollador_lectura.arn
}

output "auditor_seguridad_arn" {
  description = "ARN del permission set AuditorSeguridad"
  value       = aws_ssoadmin_permission_set.auditor_seguridad.arn
}
