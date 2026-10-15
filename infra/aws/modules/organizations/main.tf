# organizations/main.tf
resource "aws_organizations_organization" "gaitas" {
  aws_service_access_principals = [
    "cloudtrail.amazonaws.com",
    "guardduty.amazonaws.com",
    "sso.amazonaws.com",
    "backup.amazonaws.com",
  ]
  feature_set          = "ALL"
  enabled_policy_types = ["SERVICE_CONTROL_POLICY"]
}

resource "aws_organizations_organizational_unit" "produccion" {
  name      = "produccion"
  parent_id = aws_organizations_organization.gaitas.roots[0].id
}

resource "aws_organizations_organizational_unit" "nonprod" {
  name      = "nonprod"
  parent_id = aws_organizations_organization.gaitas.roots[0].id
}

resource "aws_organizations_organizational_unit" "respaldos" {
  name      = "respaldos"
  parent_id = aws_organizations_organization.gaitas.roots[0].id
}

resource "aws_organizations_organizational_unit" "seguridad" {
  name      = "seguridad"
  parent_id = aws_organizations_organization.gaitas.roots[0].id
}

# SCP: prohíbe servicios no permitidos por ADR-004
resource "aws_organizations_policy" "deny_forbidden_services" {
  name        = "gaitas-deny-forbidden-services"
  description = "Prohíbe DynamoDB, Lambda, SQS y Cognito en toda la organización (ADR-004)"
  type        = "SERVICE_CONTROL_POLICY"

  content = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyForbiddenServices"
        Effect = "Deny"
        Action = [
          "dynamodb:*",
          "lambda:*",
          "sqs:*",
          "cognito-idp:*",
          "cognito-identity:*",
          "cognito-sync:*",
        ]
        Resource = "*"
      },
      {
        Sid    = "DenyLongLivedIAMKeys"
        Effect = "Deny"
        Action = [
          "iam:CreateAccessKey",
          "iam:CreateUser",
        ]
        Resource = "*"
        Condition = {
          StringNotEquals = {
            "aws:PrincipalArn" = [
              "arn:aws:iam::*:root",
            ]
          }
        }
      },
    ]
  })

  tags = local.tags
}

resource "aws_organizations_policy_attachment" "deny_forbidden_root" {
  policy_id = aws_organizations_policy.deny_forbidden_services.id
  target_id = aws_organizations_organization.gaitas.roots[0].id
}

locals {
  tags = {
    proyecto         = "gaitas"
    entorno          = var.entorno
    "nivel-servicio" = var.nivel_servicio
    dueno            = var.dueno
  }
}
