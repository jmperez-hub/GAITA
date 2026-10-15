# Módulo: budgets

Crea presupuestos mensuales de costo en AWS Budgets con alertas vía SNS y correo electrónico.

## Qué crea

| Recurso | Descripción |
|---------|-------------|
| `aws_sns_topic` | Topic SNS cifrado con KMS para notificaciones de presupuesto |
| `aws_sns_topic_subscription` | Suscripción de correo por cada dirección en `correos_alerta` |
| `aws_budgets_budget` | Un presupuesto por entrada en `limites_por_cuenta` |

Cada presupuesto genera **dos alertas**:
- **80% consumido** (ACTUAL) → aviso preventivo
- **100% proyectado** (FORECASTED) → acción inmediata

## Costo estimado

- AWS Budgets: primeros 2 presupuestos gratuitos; adicionales $0.02/día cada uno
- SNS + correo: prácticamente $0/mes en el volumen esperado

## Configuración por entorno

| Entorno | Límite por defecto |
|---------|--------------------|
| nonprod | $200 USD/mes |
| prod | $500 USD/mes |

Ajustar en `terraform.tfvars`:

```hcl
limites_por_cuenta     = { nonprod = "300" }
correos_alerta         = ["ti@laoccidental.com", "cfo@laoccidental.com"]
```

## Prerrequisitos

- Confirmar correos de alerta en SNS (AWS enviará un correo de confirmación tras el apply).
- Módulo `kms` aplicado previamente para obtener `kms_key_arn_plataforma`.

## Riesgos

- Los correos de suscripción SNS **deben confirmarse manualmente** — si no se confirman, no llegan alertas.
- El presupuesto es de alerta, no de bloqueo. Un costo por encima del límite no detiene recursos.
