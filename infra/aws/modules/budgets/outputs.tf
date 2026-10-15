# budgets/outputs.tf

output "sns_topic_arn" {
  description = "ARN del tópico SNS de alertas de presupuesto"
  value       = aws_sns_topic.alertas_presupuesto.arn
}

output "budget_ids" {
  description = "Mapa de nombre de cuenta → nombre del budget creado"
  value       = { for k, b in aws_budgets_budget.cuenta : k => b.id }
}
