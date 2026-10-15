# eks/outputs.tf

output "cluster_name" {
  description = "Nombre del clúster EKS."
  value       = aws_eks_cluster.gaitas.name
}

output "cluster_endpoint" {
  description = "Endpoint privado del plano de control de EKS (accesible sólo desde la VPC o VPN)."
  value       = aws_eks_cluster.gaitas.endpoint
}

output "cluster_arn" {
  description = "ARN del clúster EKS."
  value       = aws_eks_cluster.gaitas.arn
}

output "cluster_certificate_authority_data" {
  description = "Certificado CA del clúster EKS en Base64, necesario para configurar kubectl."
  value       = aws_eks_cluster.gaitas.certificate_authority[0].data
  sensitive   = true
}

output "oidc_provider_arn" {
  description = "ARN del proveedor OIDC de IAM, requerido para crear roles IRSA adicionales."
  value       = aws_iam_openid_connect_provider.eks.arn
}

output "oidc_provider_url" {
  description = "URL del proveedor OIDC del clúster (sin https://)."
  value       = replace(aws_iam_openid_connect_provider.eks.url, "https://", "")
}

output "node_group_arn" {
  description = "ARN del grupo de nodos administrado 'general'."
  value       = aws_eks_node_group.general.arn
}

output "cluster_autoscaler_role_arn" {
  description = "ARN del rol IAM (IRSA) que debe anotarse en el ServiceAccount del cluster-autoscaler."
  value       = aws_iam_role.cluster_autoscaler.arn
}
