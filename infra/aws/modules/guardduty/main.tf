# guardduty/main.tf
locals {
  tags = {
    proyecto         = "gaitas"
    entorno          = var.entorno
    "nivel-servicio" = var.nivel_servicio
    dueño            = var.dueno
  }
}

resource "aws_guardduty_detector" "management" {
  enable = true

  datasources {
    s3_logs { enable = true }
    kubernetes {
      audit_logs { enable = true }
    }
    malware_protection {
      scan_ec2_instance_with_findings {
        ebs_volumes { enable = true }
      }
    }
  }

  tags = local.tags
}

resource "aws_guardduty_organization_admin_account" "seguridad" {
  admin_account_id = var.cuenta_seguridad
}

resource "aws_guardduty_organization_configuration" "gaitas" {
  auto_enable_organization_members = "ALL"
  detector_id                      = aws_guardduty_detector.management.id

  datasources {
    s3_logs { auto_enable = true }
    kubernetes {
      audit_logs { enable = true }
    }
    malware_protection {
      scan_ec2_instance_with_findings {
        ebs_volumes { auto_enable = true }
      }
    }
  }

  depends_on = [aws_guardduty_organization_admin_account.seguridad]
}
