# vpn-caracas/main.tf
locals {
  tags = {
    proyecto         = "gaitas"
    entorno          = var.entorno
    "nivel-servicio" = var.nivel_servicio
    dueno            = var.dueno
  }
}

resource "aws_customer_gateway" "caracas" {
  bgp_asn    = var.bgp_asn_caracas
  ip_address = var.ip_publica_caracas
  type       = "ipsec.1"
  tags       = merge(local.tags, { Name = "gaitas-cgw-caracas" })
}

resource "aws_vpn_gateway" "gaitas" {
  vpc_id = var.vpc_id
  tags   = merge(local.tags, { Name = "gaitas-vgw-${var.entorno}" })
}

resource "aws_vpn_connection" "caracas" {
  vpn_gateway_id      = aws_vpn_gateway.gaitas.id
  customer_gateway_id = aws_customer_gateway.caracas.id
  type                = "ipsec.1"
  static_routes_only  = true

  tunnel1_ike_versions                 = ["ikev2"]
  tunnel2_ike_versions                 = ["ikev2"]
  tunnel1_phase1_dh_group_numbers      = [20]
  tunnel2_phase1_dh_group_numbers      = [20]
  tunnel1_phase2_dh_group_numbers      = [20]
  tunnel2_phase2_dh_group_numbers      = [20]
  tunnel1_phase1_encryption_algorithms = ["AES256"]
  tunnel2_phase1_encryption_algorithms = ["AES256"]
  tunnel1_phase2_encryption_algorithms = ["AES256-GCM-16"]
  tunnel2_phase2_encryption_algorithms = ["AES256-GCM-16"]

  tags = merge(local.tags, { Name = "gaitas-vpn-caracas-${var.entorno}" })
}

resource "aws_vpn_connection_route" "caracas" {
  for_each               = toset(var.cidr_caracas)
  vpn_connection_id      = aws_vpn_connection.caracas.id
  destination_cidr_block = each.value
}

resource "aws_vpn_gateway_route_propagation" "privada" {
  vpn_gateway_id = aws_vpn_gateway.gaitas.id
  route_table_id = var.route_table_privada_id
}
