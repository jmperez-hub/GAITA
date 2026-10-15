# budgets/main.tf
locals {
  tags = {
    proyecto         = "gaitas"
    entorno          = var.entorno
    "nivel-servicio" = var.nivel_servicio
    dueño            = var.dueno
  }
}

resource "aws_sns_topic" "alertas_presupuesto" {
  name              = "gaitas-alertas-presupuesto-${var.entorno}"
  kms_master_key_id = var.kms_key_arn_plataforma
  tags              = local.tags
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.correos_alerta)
  topic_arn = aws_sns_topic.alertas_presupuesto.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_budgets_budget" "cuenta" {
  for_each = var.limites_por_cuenta

  name         = "gaitas-budget-${each.key}-${var.entorno}"
  budget_type  = "COST"
  limit_amount = each.value
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alertas_presupuesto.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alertas_presupuesto.arn]
  }

  tags = local.tags
}
