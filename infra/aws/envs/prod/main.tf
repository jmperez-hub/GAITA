# envs/prod/main.tf
# Entorno de PRODUCCIÓN de GAITAS.
# SIN workflow de apply en F0 — no hay infra-prod.yml en esta fase.
# Ninguna persona ni pipeline debe aplicar este entorno hasta que
# F0 esté aprobado y los valores {VALOR} estén completados.

module "organizations" {
  source = "../../modules/organizations"

  entorno        = "prod"
  nivel_servicio = "critico"
  dueno          = var.dueno
}

module "identity_center" {
  source = "../../modules/identity-center"

  entorno        = "prod"
  nivel_servicio = "critico"
  dueno          = var.dueno
}

module "kms" {
  source = "../../modules/kms"

  cuenta_id      = var.cuenta_prod
  rol_salud_arn  = var.rol_salud_arn
  entorno        = "prod"
  nivel_servicio = "critico"
  dueno          = var.dueno
}

module "cloudtrail" {
  source = "../../modules/cloudtrail"

  cuenta_respaldos      = var.cuenta_respaldos
  cuenta_management     = var.cuenta_management
  region                = var.region
  kms_key_arn_respaldos = module.kms.respaldos_key_arn
  entorno               = "prod"
  nivel_servicio        = "critico"
  dueno                 = var.dueno
}

module "guardduty" {
  source = "../../modules/guardduty"

  cuenta_seguridad = var.cuenta_seguridad
  entorno          = "prod"
  nivel_servicio   = "critico"
  dueno            = var.dueno
}

module "network" {
  source = "../../modules/network"

  region                 = var.region
  vpc_cidr               = var.vpc_cidr
  availability_zones     = var.availability_zones
  kms_key_arn_plataforma = module.kms.plataforma_key_arn
  entorno                = "prod"
  nivel_servicio         = "critico"
  dueno                  = var.dueno
}

module "eks" {
  source = "../../modules/eks"

  vpc_id                 = module.network.vpc_id
  private_subnet_ids     = module.network.private_subnet_ids
  kubernetes_version     = var.kubernetes_version
  instance_types         = ["t3.large"]
  node_min               = 3
  node_max               = 8
  node_desired           = 3
  node_disk_gb           = 100
  kms_key_arn_plataforma = module.kms.plataforma_key_arn
  entorno                = "prod"
  nivel_servicio         = "critico"
  dueno                  = var.dueno
}

module "backups_bucket" {
  source = "../../modules/backups-bucket"

  cuenta_id             = var.cuenta_prod
  kms_key_arn_respaldos = module.kms.respaldos_key_arn
  rol_backup_arn        = var.rol_backup_arn
  entorno               = "prod"
  nivel_servicio        = "critico"
  dueno                 = var.dueno
}

module "vpn_caracas" {
  source = "../../modules/vpn-caracas"

  vpc_id                 = module.network.vpc_id
  ip_publica_caracas     = var.ip_publica_caracas
  bgp_asn_caracas        = var.bgp_asn_caracas
  cidr_caracas           = var.cidr_caracas
  route_table_privada_id = module.network.private_route_table_id
  entorno                = "prod"
  nivel_servicio         = "critico"
  dueno                  = var.dueno
}

module "budgets" {
  source = "../../modules/budgets"

  kms_key_arn_plataforma = module.kms.plataforma_key_arn
  correos_alerta         = var.correos_alerta
  limites_por_cuenta     = { prod = var.presupuesto_mensual_usd }
  entorno                = "prod"
  nivel_servicio         = "critico"
  dueno                  = var.dueno
}
