# Módulo KMS — GAITAS

Crea tres llaves KMS de administración por el cliente (CMK) para el proyecto GAITAS / La Occidental de Seguros.

## Llaves creadas

| Alias | Propósito | Sensible |
|---|---|---|
| `alias/gaitas-plataforma` | EKS, volúmenes EBS generales, CloudWatch Logs | No |
| `alias/gaitas-respaldos` | Bucket S3 con Object Lock, CloudTrail | No |
| `alias/gaitas-datos-salud` | Datos de salud (Art. 67 LSIB, ADR-004 regla 8) | **Sí** |

## Arquitectura de políticas

### `gaitas-plataforma` y `gaitas-respaldos`
Usan la política predeterminada de KMS: la cuenta raíz tiene acceso completo y los permisos se administran mediante IAM. La rotación automática anual está habilitada en ambas.

### `gaitas-datos-salud`
Política de llave restrictiva con tres declaraciones:

1. **AllowAccountRoot** — la raíz de la cuenta puede administrar la llave (revocar, deshabilitar, auditar).
2. **AllowSaludModuleEncrypt** — únicamente el rol IAM `var.rol_salud_arn` puede ejecutar `GenerateDataKey` y `Decrypt`. Ningún otro principal puede cifrar ni descifrar datos de salud.
3. **DenyCloudTrailLogging** — impide que CloudTrail use esta llave para cifrar sus propios logs, garantizando que los datos de salud **nunca** aparezcan en registros de auditoría de acceso general (ADR-004 regla 8).

Los outputs de esta llave se marcan `sensitive = true` para evitar que el ARN aparezca en texto plano en los planes de OpenTofu.

## Estimación de costos (us-east-1, octubre 2026)

| Recurso | Costo mensual |
|---|---|
| 3 llaves CMK × $1.00/mes | $3.00 |
| Llamadas API (estimado 10 000/mes) | < $0.03 |
| **Total estimado** | **~$3/mes** |

Referencia: [Precios KMS AWS](https://aws.amazon.com/kms/pricing/)

## Riesgos y controles

### Rotación sin actualizar consumidores
KMS guarda todas las versiones de material de llave, por lo que los datos cifrados con versiones anteriores siguen siendo descifrables. Sin embargo, si un servicio cachea el ARN de una versión específica (raro pero posible en algunos SDKs), la rotación puede causar errores `InvalidKeyId`. **Control:** revisar que los consumidores usen el alias, no el Key ID directo.

### Eliminación accidental de llave
`deletion_window_in_days = 30` proporciona un período de espera obligatorio. Durante ese período la llave puede ser cancelada. **Control:** configurar una alarma CloudWatch en la métrica `kms:ScheduleKeyDeletion` para el proyecto GAITAS.

### Exfiltración del ARN de datos-salud
El ARN de la llave de salud está marcado `sensitive` en outputs. **Control:** nunca pasar `datos_salud_key_arn` a módulos que no sean el de procesamiento de salud; usar referencias directas entre módulos en vez de variables de entorno.

## Uso

```hcl
module "kms" {
  source         = "../modules/kms"
  entorno        = "nonprod"
  nivel_servicio = "alto"
  dueno          = "plataforma"
  cuenta_id      = "{CUENTA_AWS_ID}"
  rol_salud_arn  = "arn:aws:iam::{CUENTA_AWS_ID}:role/gaitas-salud-processor"
}
```

## Prerequisitos

- Proveedor AWS configurado con permisos `kms:CreateKey`, `kms:CreateAlias`, `kms:PutKeyPolicy`.
- El rol `rol_salud_arn` debe existir antes de aplicar el módulo (o usar `depends_on` en el módulo que lo crea).
