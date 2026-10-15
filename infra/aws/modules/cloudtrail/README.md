# Módulo: cloudtrail

Crea un trail organizacional de AWS CloudTrail con almacenamiento a largo plazo en un bucket S3 en la cuenta de respaldos. Cumple con el Art. 67 de la Ley del Sistema de Seguros (LSIB) que exige retención de registros por 7 años.

## Qué crea

| Recurso | Nombre | Descripción |
|---|---|---|
| `aws_s3_bucket` | `gaitas-cloudtrail-{cuenta_respaldos}` | Bucket para almacenar logs de CloudTrail |
| `aws_s3_bucket_versioning` | — | Versionado habilitado en el bucket |
| `aws_s3_bucket_object_lock_configuration` | — | Object Lock en modo COMPLIANCE, retención 7 años |
| `aws_s3_bucket_server_side_encryption_configuration` | — | Cifrado SSE-KMS con clave de respaldos |
| `aws_s3_bucket_public_access_block` | — | Bloqueo total de acceso público |
| `aws_s3_bucket_policy` | — | Política que permite solo a CloudTrail escribir logs |
| `aws_cloudtrail` | `gaitas-org-trail` | Trail multi-región organizacional con validación de logs |

### Características del trail

- **Multi-región:** captura eventos de todas las regiones AWS.
- **Organizacional:** cubre todas las cuentas miembro de la organización.
- **Eventos globales:** incluye IAM, STS y otros servicios globales.
- **Validación de integridad:** `enable_log_file_validation = true` genera digest files firmados.
- **Cifrado KMS:** todos los logs cifrados con la clave KMS de la cuenta de respaldos.
- **Eventos de gestión:** captura lecturas y escrituras de eventos de management.

### Retención y cumplimiento normativo

El bucket usa S3 Object Lock en modo **COMPLIANCE** con retención de **7 años** conforme al Art. 67 LSIB. En modo COMPLIANCE ni el root de la cuenta puede eliminar objetos antes de que expire la retención.

## Costo estimado

Los costos dependen del volumen de eventos en la organización. Referencia orientativa:

| Componente | Modelo de costo |
|---|---|
| CloudTrail — primer trail organizacional | Gratis (management events) |
| CloudTrail — data events adicionales | USD por cada 100 000 eventos |
| S3 — almacenamiento de logs | USD por GB/mes (varía según región) |
| S3 — solicitudes PUT de CloudTrail | USD por cada 1 000 solicitudes |
| KMS — solicitudes de cifrado/descifrado | USD por 10 000 solicitudes |

> Para una organización con 10 cuentas activas se estima un costo mensual de storage de USD 5–20 en el primer año, creciente con el tiempo por acumulación de 7 años de retención.

## Riesgos y consideraciones

| Riesgo | Mitigación |
|---|---|
| `force_destroy = false` — el bucket no puede eliminarse si contiene objetos | Diseño intencional para proteger logs de auditoría; eliminar manualmente solo bajo autorización del CISO |
| Object Lock en modo COMPLIANCE es irreversible hasta el vencimiento | Verificar que `years = 7` cumple con los requisitos legales antes de aplicar; no puede reducirse después |
| El trail debe crearse desde la cuenta de management con permisos de organización | Ejecutar este módulo únicamente desde la cuenta de management |
| El bucket se crea en la cuenta de respaldos pero el trail en la cuenta de management | Desplegar el módulo en la región correcta; usar `provider` aliases si las cuentas tienen distintos perfiles |
| La clave KMS debe tener una política que permita a CloudTrail usar `kms:GenerateDataKey*` y `kms:Decrypt` | Configurar la key policy de la clave KMS antes de aplicar este módulo |

## Requisitos previos

1. Organización AWS configurada (módulo `organizations` aplicado).
2. Cuenta de respaldos existente y en la OU `respaldos`.
3. Clave KMS creada en la cuenta de respaldos con política que permita `cloudtrail.amazonaws.com` usar `kms:GenerateDataKey*` y `kms:DescribeKey`.
4. Credenciales con permisos `cloudtrail:*`, `s3:*` y `kms:DescribeKey` en la cuenta de management.

## Cómo aplicar

```bash
# 1. Configurar credenciales (SSO)
aws sso login --profile gaitas-management

# 2. Inicializar el módulo
tofu init

# 3. Revisar el plan
tofu plan \
  -var='entorno=prod' \
  -var='nivel_servicio=critico' \
  -var='cuenta_respaldos={ACCOUNT_ID_RESPALDOS}' \
  -var='cuenta_management={ACCOUNT_ID_MANAGEMENT}' \
  -var='kms_key_arn_respaldos=arn:aws:kms:us-east-1:{ACCOUNT_ID_RESPALDOS}:key/{KEY_ID}'

# 4. Aplicar
tofu apply \
  -var='entorno=prod' \
  -var='nivel_servicio=critico' \
  -var='cuenta_respaldos={ACCOUNT_ID_RESPALDOS}' \
  -var='cuenta_management={ACCOUNT_ID_MANAGEMENT}' \
  -var='kms_key_arn_respaldos=arn:aws:kms:us-east-1:{ACCOUNT_ID_RESPALDOS}:key/{KEY_ID}'
```

## Variables

| Variable | Tipo | Default | Descripción |
|---|---|---|---|
| `entorno` | string | — | `nonprod` o `prod` |
| `nivel_servicio` | string | `critico` | `critico`, `alto`, `medio` o `bajo` |
| `dueno` | string | `plataforma@laoccidental.com` | Equipo responsable |
| `cuenta_respaldos` | string | — | ID de 12 dígitos de la cuenta de respaldos |
| `cuenta_management` | string | — | ID de 12 dígitos de la cuenta de management |
| `region` | string | `us-east-1` | Región AWS principal del trail |
| `kms_key_arn_respaldos` | string | — | ARN de la clave KMS en la cuenta de respaldos |

## Outputs

| Output | Descripción |
|---|---|
| `bucket_name` | Nombre del bucket S3 de logs |
| `bucket_arn` | ARN del bucket S3 de logs |
| `trail_arn` | ARN del trail organizacional |
| `trail_home_region` | Región principal del trail |
