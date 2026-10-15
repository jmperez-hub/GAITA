output "detector_id" {
  description = "ID del detector de GuardDuty en la cuenta de management"
  value       = aws_guardduty_detector.management.id
}

output "admin_account_id" {
  description = "ID de la cuenta de seguridad designada como administrador delegado de GuardDuty"
  value       = aws_guardduty_organization_admin_account.seguridad.admin_account_id
}
