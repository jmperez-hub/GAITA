# backups-bucket/main.tf
locals {
  tags = {
    proyecto         = "gaitas"
    entorno          = var.entorno
    "nivel-servicio" = var.nivel_servicio
    dueño            = var.dueno
  }

  bucket_name = "gaitas-respaldos-${var.cuenta_id}"
}

# El bucket debe crearse con Object Lock habilitado desde el inicio (no se puede activar después)
resource "aws_s3_bucket" "respaldos" {
  bucket              = local.bucket_name
  object_lock_enabled = true
  tags                = merge(local.tags, { proposito = "respaldos-regulatorios" })
}

resource "aws_s3_bucket_versioning" "respaldos" {
  bucket = aws_s3_bucket.respaldos.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Object Lock: modo COMPLIANCE, 7 años (2557 días) conforme Art. 67 LSIB
resource "aws_s3_bucket_object_lock_configuration" "respaldos" {
  bucket = aws_s3_bucket.respaldos.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 2557
    }
  }

  depends_on = [aws_s3_bucket_versioning.respaldos]
}

# Cifrado SSE-KMS con bucket key para reducir llamadas a KMS (~99% reducción de costos KMS)
resource "aws_s3_bucket_server_side_encryption_configuration" "respaldos" {
  bucket = aws_s3_bucket.respaldos.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn_respaldos
    }
    bucket_key_enabled = true
  }
}

# Bloquear todo acceso público
resource "aws_s3_bucket_public_access_block" "respaldos" {
  bucket = aws_s3_bucket.respaldos.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle: transición a Glacier después de 365 días, expiración a los 2557 días
resource "aws_s3_bucket_lifecycle_configuration" "respaldos" {
  bucket = aws_s3_bucket.respaldos.id

  rule {
    id     = "gaitas-archivado-glacier"
    status = "Enabled"

    transition {
      days          = 365
      storage_class = "GLACIER"
    }

    expiration {
      days = 2557
    }

    noncurrent_version_transition {
      noncurrent_days = 90
      storage_class   = "GLACIER"
    }

    noncurrent_version_expiration {
      noncurrent_days = 2557
    }
  }

  depends_on = [aws_s3_bucket_versioning.respaldos]
}

# Política del bucket: denegar acceso sin TLS y restringir escritura al rol de backup
resource "aws_s3_bucket_policy" "respaldos" {
  bucket = aws_s3_bucket.respaldos.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action   = "s3:*"
        Resource = [
          "arn:aws:s3:::${local.bucket_name}",
          "arn:aws:s3:::${local.bucket_name}/*"
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      {
        Sid    = "AllowBackupRoleReadWrite"
        Effect = "Allow"
        Principal = { AWS = var.rol_backup_arn }
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket",
          "s3:GetObjectVersion",
          "s3:GetBucketObjectLockConfiguration",
          "s3:GetObjectRetention"
        ]
        Resource = [
          "arn:aws:s3:::${local.bucket_name}",
          "arn:aws:s3:::${local.bucket_name}/*"
        ]
      },
      {
        Sid    = "DenyObjectLockBypass"
        Effect = "Deny"
        Principal = "*"
        Action = [
          "s3:BypassGovernanceRetention",
          "s3:PutObjectLegalHold",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion"
        ]
        Resource = "arn:aws:s3:::${local.bucket_name}/*"
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.respaldos]
}
