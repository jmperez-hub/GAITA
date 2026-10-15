# Módulo Backups Bucket — GAITAS

Crea el bucket S3 de respaldos regulatorios de GAITAS con Object Lock en modo COMPLIANCE, cifrado KMS, bloqueo de acceso público y reglas de ciclo de vida. Cumple el requisito de retención de 7 años del Artículo 67 de la LSIB (Ley de la Actividad Aseguradora de Venezuela).

## Características del bucket

| Característica | Configuración |
|---|---|
| Nombre | `gaitas-respaldos-{cuenta_id}` |
| Object Lock | **COMPLIANCE**, 2557 días (7 años) |
| Versionado | Habilitado |
| Cifrado | SSE-KMS con llave `gaitas-respaldos`, Bucket Key habilitada |
| Acceso público | Bloqueado completamente (4 configuraciones) |
| Transición a Glacier | 365 días |
| Expiración | 2557 días |

## Object Lock — modo COMPLIANCE

En modo COMPLIANCE, **ningún usuario de AWS — incluyendo root — puede eliminar ni modificar la retención de un objeto** durante el período activo. Esto es un requisito explícito del Art. 67 LSIB que exige conservar documentos de pólizas y siniestros durante 7 años mínimos.

> **Advertencia:** Una vez creado el bucket con Object Lock, no se puede deshabilitar. Si se necesita eliminar el bucket antes del vencimiento de los objetos, se debe escalar a AWS Support con justificación regulatoria. Planificar el nombre del bucket con cuidado antes de aplicar.

## Política del bucket

La política incluye tres declaraciones:

1. **DenyNonTLS** — rechaza cualquier solicitud que no use HTTPS (`aws:SecureTransport = false`). Aplica a todos los principals, incluyendo roles internos.
2. **AllowBackupRoleReadWrite** — permite al rol de backup (`var.rol_backup_arn`) leer, escribir y listar objetos, incluidas operaciones de Object Lock de lectura.
3. **DenyObjectLockBypass** — deniega explícitamente las acciones de eliminación y bypass de retención a cualquier principal, reforzando el modo COMPLIANCE a nivel de política.

## Ciclo de vida y costos estimados (us-east-1)

| Período | Clase de almacenamiento | Costo aproximado por TB/mes |
|---|---|---|
| 0–365 días | S3 Standard | $23.00 |
| 365–2557 días | S3 Glacier | $3.60 |

**Ejemplo con 1 TB de respaldos:**
- Año 1 (Standard): ~$23/mes
- Años 2–7 (Glacier): ~$3.60/mes
- Bucket Key habilitada reduce el costo de llamadas KMS en ~99%

## Uso

```hcl
module "backups_bucket" {
  source                = "../modules/backups-bucket"
  entorno               = "prod"
  nivel_servicio        = "critico"
  dueno                 = "operaciones"
  cuenta_id             = "{CUENTA_AWS_ID}"
  kms_key_arn_respaldos = module.kms.respaldos_key_arn
  rol_backup_arn        = "arn:aws:iam::{CUENTA_AWS_ID}:role/gaitas-backup-agent"
}
```

## Casos de uso del bucket

- Respaldos diarios de bases de datos PostgreSQL (vía AWS Backup)
- Exportaciones de reportes regulatorios (SUNAVAL, SUDEASEG)
- Overflow de CloudTrail (logs de auditoría de largo plazo)
- Snapshots de EKS/volúmenes EBS exportados

## Prerequisitos

- La llave KMS `gaitas-respaldos` debe existir antes de aplicar (módulo `kms` primero)
- El rol IAM `rol_backup_arn` debe existir antes de aplicar
- Los nombres de buckets S3 son globales: una vez creado con este nombre no puede recrearse inmediatamente si se elimina
