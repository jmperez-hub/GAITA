# Módulo: guardduty

Habilita AWS GuardDuty a nivel organizacional para la plataforma GAITAS de La Occidental de Seguros. Configura la cuenta de seguridad como administrador delegado y activa la habilitación automática para todas las cuentas miembro.

## Qué crea

| Recurso | Nombre | Descripción |
|---|---|---|
| `aws_guardduty_detector` | — | Detector en la cuenta de management con S3, Kubernetes y Malware Protection habilitados |
| `aws_guardduty_organization_admin_account` | — | Designa la cuenta de seguridad como administrador delegado |
| `aws_guardduty_organization_configuration` | — | Configura habilitación automática para cuentas miembro nuevas y existentes |

### Fuentes de datos habilitadas

| Fuente | Configuración | Descripción |
|---|---|---|
| S3 Protection | `enable = true` (detector), `auto_enable = true` (org) | Detecta accesos anómalos a buckets S3 |
| Kubernetes Audit Logs | `enable = true` (detector y org) | Analiza logs de auditoría de clústeres EKS |
| Malware Protection — EBS | `enable = true` (detector), `auto_enable = true` (org) | Escanea volúmenes EBS de instancias EC2 con hallazgos sospechosos |

### Habilitación automática de miembros

`auto_enable_organization_members = "ALL"` garantiza que todas las cuentas actuales y futuras de la organización tengan GuardDuty activado automáticamente. No requiere configuración manual por cuenta.

## Costo estimado

GuardDuty cobra según el volumen de datos analizados. Los principales factores son:

| Fuente de datos | Modelo de costo |
|---|---|
| CloudTrail management events | USD por millón de eventos analizados |
| CloudTrail S3 data events | USD por millón de eventos |
| VPC Flow Logs | USD por GB analizado |
| DNS logs | USD por millón de consultas |
| S3 Protection | USD por millón de solicitudes S3 |
| Malware Protection | USD por GB de volúmenes EBS escaneados |

> Para una organización de 5–10 cuentas con actividad moderada se estima un costo mensual de USD 50–200. Usar la calculadora de AWS para una estimación precisa según el volumen real de eventos.

## Riesgos y consideraciones

| Riesgo | Mitigación |
|---|---|
| El administrador delegado (`cuenta_seguridad`) debe ser una cuenta miembro de la organización y no la cuenta de management | Verificar con `aws organizations list-accounts` antes de aplicar |
| `aws_guardduty_organization_admin_account` solo puede tener un administrador delegado a la vez | Si ya existe un administrador delegado diferente, eliminarlo antes de aplicar con `aws guardduty disable-organization-admin-account` |
| `auto_enable_organization_members = "ALL"` puede generar costos inesperados en cuentas de desarrollo con alta actividad de API | Monitorear costos con AWS Cost Explorer durante los primeros 30 días; considerar usar `"NEW"` si el costo de cuentas existentes es prohibitivo |
| Los hallazgos de GuardDuty no se exportan automáticamente a S3 o SIEM | Configurar `aws_guardduty_publishing_destination` para exportar hallazgos al bucket de respaldos o al SIEM de la organización |
| Kubernetes Audit Logs requiere EKS con el controlador de logs habilitado | Verificar que los clústeres EKS tengan el audit logging activo en la configuración del clúster |

## Requisitos previos

1. Organización AWS configurada con GuardDuty habilitado como servicio de confianza: `aws organizations enable-aws-service-access --service-principal guardduty.amazonaws.com`.
2. Cuenta de seguridad existente y en la OU `seguridad`.
3. Credenciales con permisos `guardduty:*` y `organizations:RegisterDelegatedAdministrator` en la cuenta de management.

## Cómo aplicar

```bash
# 1. Habilitar GuardDuty como servicio de confianza en la organización
aws organizations enable-aws-service-access \
  --service-principal guardduty.amazonaws.com

# 2. Configurar credenciales (SSO)
aws sso login --profile gaitas-management

# 3. Inicializar el módulo
tofu init

# 4. Revisar el plan
tofu plan \
  -var='entorno=prod' \
  -var='nivel_servicio=critico' \
  -var='cuenta_seguridad={ACCOUNT_ID_SEGURIDAD}'

# 5. Aplicar
tofu apply \
  -var='entorno=prod' \
  -var='nivel_servicio=critico' \
  -var='cuenta_seguridad={ACCOUNT_ID_SEGURIDAD}'
```

## Variables

| Variable | Tipo | Default | Descripción |
|---|---|---|---|
| `entorno` | string | — | `nonprod` o `prod` |
| `nivel_servicio` | string | `critico` | `critico`, `alto`, `medio` o `bajo` |
| `dueno` | string | `plataforma@laoccidental.com` | Equipo responsable |
| `cuenta_seguridad` | string | — | ID de 12 dígitos de la cuenta de seguridad (administrador delegado) |

## Outputs

| Output | Descripción |
|---|---|
| `detector_id` | ID del detector de GuardDuty en la cuenta de management |
| `admin_account_id` | ID de la cuenta designada como administrador delegado |
