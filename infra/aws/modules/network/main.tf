# network/main.tf
locals {
  tags = {
    proyecto         = "gaitas"
    entorno          = var.entorno
    "nivel-servicio" = var.nivel_servicio
    dueño            = var.dueno
  }
}

resource "aws_vpc" "gaitas" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "gaitas-vpc-${var.entorno}" })
}

resource "aws_subnet" "privada" {
  for_each                = { for i, az in var.availability_zones : az => i }
  vpc_id                  = aws_vpc.gaitas.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, each.value)
  availability_zone       = each.key
  map_public_ip_on_launch = false
  tags = merge(local.tags, {
    Name                                          = "gaitas-privada-${each.key}"
    "kubernetes.io/role/internal-elb"             = "1"
    "kubernetes.io/cluster/gaitas-${var.entorno}" = "owned"
  })
}

# Subred pública solo para el NAT gateway
resource "aws_subnet" "nat" {
  for_each                = { for i, az in var.availability_zones : az => i }
  vpc_id                  = aws_vpc.gaitas.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, each.value + 8)
  availability_zone       = each.key
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "gaitas-nat-${each.key}" })
}

resource "aws_internet_gateway" "gaitas" {
  vpc_id = aws_vpc.gaitas.id
  tags   = merge(local.tags, { Name = "gaitas-igw-${var.entorno}" })
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = merge(local.tags, { Name = "gaitas-nat-eip-${var.entorno}" })
}

# Un solo NAT gateway (primera AZ) para reducir costos en nonprod
resource "aws_nat_gateway" "gaitas" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.nat[var.availability_zones[0]].id
  tags          = merge(local.tags, { Name = "gaitas-nat-${var.entorno}" })
  depends_on    = [aws_internet_gateway.gaitas]
}

resource "aws_route_table" "privada" {
  vpc_id = aws_vpc.gaitas.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.gaitas.id
  }
  tags = merge(local.tags, { Name = "gaitas-rt-privada-${var.entorno}" })
}

resource "aws_route_table_association" "privada" {
  for_each       = aws_subnet.privada
  subnet_id      = each.value.id
  route_table_id = aws_route_table.privada.id
}

resource "aws_route_table" "nat" {
  vpc_id = aws_vpc.gaitas.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.gaitas.id
  }
  tags = merge(local.tags, { Name = "gaitas-rt-nat-${var.entorno}" })
}

resource "aws_route_table_association" "nat" {
  for_each       = aws_subnet.nat
  subnet_id      = each.value.id
  route_table_id = aws_route_table.nat.id
}

# Default SG: sin tráfico permitido
resource "aws_default_security_group" "gaitas" {
  vpc_id = aws_vpc.gaitas.id
  tags   = merge(local.tags, { Name = "gaitas-default-sg-DENY" })
}

# S3 Gateway endpoint (sin costo)
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.gaitas.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.privada.id]
  tags              = merge(local.tags, { Name = "gaitas-ep-s3" })
}

# ECR interface endpoints
resource "aws_vpc_endpoint" "ecr_api" {
  vpc_id              = aws_vpc.gaitas.id
  service_name        = "com.amazonaws.${var.region}.ecr.api"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.privada : s.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "gaitas-ep-ecr-api" })
}

resource "aws_vpc_endpoint" "ecr_dkr" {
  vpc_id              = aws_vpc.gaitas.id
  service_name        = "com.amazonaws.${var.region}.ecr.dkr"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.privada : s.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "gaitas-ep-ecr-dkr" })
}

# STS interface endpoint
resource "aws_vpc_endpoint" "sts" {
  vpc_id              = aws_vpc.gaitas.id
  service_name        = "com.amazonaws.${var.region}.sts"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.privada : s.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "gaitas-ep-sts" })
}

resource "aws_security_group" "endpoints" {
  name        = "gaitas-endpoints-sg"
  description = "Permite HTTPS desde la VPC hacia los endpoints de interfaz"
  vpc_id      = aws_vpc.gaitas.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
    description = "HTTPS desde la VPC"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Todo el egreso"
  }

  tags = merge(local.tags, { Name = "gaitas-endpoints-sg" })
}

# VPC Flow Logs
resource "aws_flow_log" "gaitas" {
  vpc_id          = aws_vpc.gaitas.id
  traffic_type    = "ALL"
  iam_role_arn    = aws_iam_role.flow_logs.arn
  log_destination = aws_cloudwatch_log_group.flow_logs.arn
  tags            = merge(local.tags, { Name = "gaitas-flow-logs" })
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/gaitas/vpc/flow-logs/${var.entorno}"
  retention_in_days = 90
  kms_key_id        = var.kms_key_arn_plataforma
  tags              = local.tags
}

resource "aws_iam_role" "flow_logs" {
  name = "gaitas-vpc-flow-logs-${var.entorno}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "gaitas-flow-logs-policy"
  role = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams"
      ]
      Resource = "*"
    }]
  })
}
