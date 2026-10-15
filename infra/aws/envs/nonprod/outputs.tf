output "vpc_id" {
  description = "ID de la VPC de nonprod"
  value       = module.network.vpc_id
}

output "eks_cluster_name" {
  description = "Nombre del cluster EKS de nonprod"
  value       = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  description = "Endpoint del plano de control EKS (solo accesible desde la VPN)"
  value       = module.eks.cluster_endpoint
  sensitive   = true
}

output "kms_plataforma_arn" {
  description = "ARN de la llave KMS de plataforma"
  value       = module.kms.plataforma_key_arn
}

output "backups_bucket_name" {
  description = "Nombre del bucket de respaldos"
  value       = module.backups_bucket.bucket_id
}

output "cloudtrail_trail_arn" {
  description = "ARN del trail organizacional de CloudTrail"
  value       = module.cloudtrail.trail_arn
}

output "vpn_tunnel1_address" {
  description = "IP pública del túnel 1 de la VPN hacia Caracas"
  value       = module.vpn_caracas.tunnel1_address
  sensitive   = true
}

output "vpn_tunnel2_address" {
  description = "IP pública del túnel 2 de la VPN hacia Caracas"
  value       = module.vpn_caracas.tunnel2_address
  sensitive   = true
}

output "budgets_sns_topic_arn" {
  description = "ARN del topic SNS de alertas de presupuesto"
  value       = module.budgets.sns_topic_arn
}
