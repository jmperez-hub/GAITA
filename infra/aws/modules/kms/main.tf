# kms/main.tf
locals {
  tags = {
    proyecto         = "gaitas"
    entorno          = var.entorno
    "nivel-servicio" = var.nivel_servicio
    dueño            = var.dueno
  }
}

resource "aws_kms_key" "plataforma" {
  description             = "GAITAS — llave de plataforma (EKS, volúmenes generales)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  multi_region            = false
  tags                    = merge(local.tags, { proposito = "plataforma" })
}

resource "aws_kms_alias" "plataforma" {
  name          = "alias/gaitas-plataforma"
  target_key_id = aws_kms_key.plataforma.key_id
}

resource "aws_kms_key" "respaldos" {
  description             = "GAITAS — llave de respaldos (S3 Object Lock, CloudTrail)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  multi_region            = false
  tags                    = merge(local.tags, { proposito = "respaldos" })
}

resource "aws_kms_alias" "respaldos" {
  name          = "alias/gaitas-respaldos"
  target_key_id = aws_kms_key.respaldos.key_id
}

# Llave datos-salud: política restrictiva — solo el rol de salud puede usar Decrypt
resource "aws_kms_key" "datos_salud" {
  description             = "GAITAS — llave datos de salud (Art. 67 LSIB, ADR-004 regla 8)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  multi_region            = false

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowAccountRoot"
        Effect = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.cuenta_id}:root" }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowSaludModuleEncrypt"
        Effect = "Allow"
        Principal = { AWS = var.rol_salud_arn }
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = "*"
      },
      {
        Sid    = "DenyCloudTrailLogging"
        Effect = "Deny"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action   = "kms:GenerateDataKey"
        Resource = "*"
      },
    ]
  })

  tags = merge(local.tags, { proposito = "datos-salud", sensible = "true" })
}

resource "aws_kms_alias" "datos_salud" {
  name          = "alias/gaitas-datos-salud"
  target_key_id = aws_kms_key.datos_salud.key_id
}
