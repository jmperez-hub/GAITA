output "organization_id" {
  description = "ID de la organización AWS"
  value       = aws_organizations_organization.gaitas.id
}

output "root_id" {
  description = "ID del root de la organización"
  value       = aws_organizations_organization.gaitas.roots[0].id
}

output "ou_produccion_id" {
  description = "ID de la OU de producción"
  value       = aws_organizations_organizational_unit.produccion.id
}

output "ou_nonprod_id" {
  description = "ID de la OU de nonprod"
  value       = aws_organizations_organizational_unit.nonprod.id
}

output "ou_respaldos_id" {
  description = "ID de la OU de respaldos"
  value       = aws_organizations_organizational_unit.respaldos.id
}

output "ou_seguridad_id" {
  description = "ID de la OU de seguridad"
  value       = aws_organizations_organizational_unit.seguridad.id
}

output "scp_deny_forbidden_id" {
  description = "ID de la SCP que prohíbe servicios no permitidos"
  value       = aws_organizations_policy.deny_forbidden_services.id
}
