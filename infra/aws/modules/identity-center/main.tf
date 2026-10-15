# identity-center/main.tf
data "aws_ssoadmin_instances" "gaitas" {}

locals {
  sso_instance_arn = tolist(data.aws_ssoadmin_instances.gaitas.arns)[0]
  sso_instance_id  = tolist(data.aws_ssoadmin_instances.gaitas.identity_store_ids)[0]
  tags = {
    proyecto         = "gaitas"
    entorno          = var.entorno
    "nivel-servicio" = var.nivel_servicio
    dueno            = var.dueno
  }
}

# Permission set: AdministradorPlataforma
resource "aws_ssoadmin_permission_set" "admin_plataforma" {
  name             = "AdministradorPlataforma"
  description      = "Acceso completo para el equipo de plataforma GAITAS"
  instance_arn     = local.sso_instance_arn
  session_duration = "PT8H"
  tags             = local.tags
}

resource "aws_ssoadmin_managed_policy_attachment" "admin_plataforma" {
  #checkov:skip=CKV_AWS_274: permission set break-glass para equipo de plataforma — acceso temporal supervisado vía SSO, sin claves de larga duración
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.admin_plataforma.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# Permission set: DesarrolladorLectura
resource "aws_ssoadmin_permission_set" "desarrollador_lectura" {
  name             = "DesarrolladorLectura"
  description      = "Lectura para desarrolladores — sin escritura en prod"
  instance_arn     = local.sso_instance_arn
  session_duration = "PT8H"
  tags             = local.tags
}

resource "aws_ssoadmin_managed_policy_attachment" "desarrollador_lectura" {
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.desarrollador_lectura.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# Permission set: AuditorSeguridad
resource "aws_ssoadmin_permission_set" "auditor_seguridad" {
  name             = "AuditorSeguridad"
  description      = "Acceso de auditoría — SecurityAudit managed policy"
  instance_arn     = local.sso_instance_arn
  session_duration = "PT4H"
  tags             = local.tags
}

resource "aws_ssoadmin_managed_policy_attachment" "auditor_seguridad" {
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.auditor_seguridad.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/SecurityAudit"
}
