# network/outputs.tf

output "vpc_id" {
  description = "ID de la VPC GAITAS"
  value       = aws_vpc.gaitas.id
}

output "vpc_cidr" {
  description = "Bloque CIDR de la VPC GAITAS"
  value       = aws_vpc.gaitas.cidr_block
}

output "private_subnet_ids" {
  description = "Lista de IDs de las subredes privadas (una por AZ)"
  value       = [for s in aws_subnet.privada : s.id]
}

output "nat_subnet_ids" {
  description = "Lista de IDs de las subredes NAT/públicas (una por AZ)"
  value       = [for s in aws_subnet.nat : s.id]
}

output "nat_gateway_id" {
  description = "ID del NAT gateway (desplegado en la primera AZ)"
  value       = aws_nat_gateway.gaitas.id
}

output "route_table_privada_id" {
  description = "ID de la tabla de rutas de las subredes privadas (necesario para el módulo VPN)"
  value       = aws_route_table.privada.id
}

output "endpoint_s3_id" {
  description = "ID del VPC endpoint Gateway para S3"
  value       = aws_vpc_endpoint.s3.id
}

output "endpoint_ecr_api_id" {
  description = "ID del VPC endpoint Interface para ECR API"
  value       = aws_vpc_endpoint.ecr_api.id
}

output "endpoint_ecr_dkr_id" {
  description = "ID del VPC endpoint Interface para ECR Docker Registry"
  value       = aws_vpc_endpoint.ecr_dkr.id
}

output "endpoint_sts_id" {
  description = "ID del VPC endpoint Interface para STS"
  value       = aws_vpc_endpoint.sts.id
}

output "security_group_endpoints_id" {
  description = "ID del security group que controla el acceso a los endpoints de interfaz"
  value       = aws_security_group.endpoints.id
}
