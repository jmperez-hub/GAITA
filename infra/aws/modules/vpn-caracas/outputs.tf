output "customer_gateway_id" {
  description = "ID del Customer Gateway (Caracas)"
  value       = aws_customer_gateway.caracas.id
}

output "vpn_gateway_id" {
  description = "ID del Virtual Private Gateway"
  value       = aws_vpn_gateway.gaitas.id
}

output "vpn_connection_id" {
  description = "ID de la conexión VPN sitio a sitio"
  value       = aws_vpn_connection.caracas.id
}

output "tunnel1_address" {
  description = "IP pública del túnel 1 (para configurar el lado Caracas)"
  value       = aws_vpn_connection.caracas.tunnel1_address
  sensitive   = true
}

output "tunnel2_address" {
  description = "IP pública del túnel 2 (para configurar el lado Caracas)"
  value       = aws_vpn_connection.caracas.tunnel2_address
  sensitive   = true
}
