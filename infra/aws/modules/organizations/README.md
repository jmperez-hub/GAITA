# Módulo: organizations

Crea la estructura de AWS Organizations para la plataforma GAITAS de La Occidental de Seguros.

## Qué crea

| Recurso | Nombre | Descripción |
|---|---|---|
| `aws_organizations_organization` | `gaitas` | Organización principal con feature set ALL |
| `aws_organizations_organizational_unit` | `produccion` | OU para cuentas de producción |
| `aws_organizations_organizational_unit` | `nonprod` | OU para cuentas de no-producción (desarrollo, staging, QA) |
| `aws_organizations_organizational_unit` | `respaldos` | OU para la cuenta centralizada de respaldos |
| `aws_organizations_organizational_unit` | `seguridad` | OU para la cuenta de seguridad/auditoría |
| `aws_organizations_policy` | `gaitas-deny-forbidden-services` | SCP que prohíbe servicios no permitidos (ADR-004) |
| `aws_organizations_policy_attachment` | — | Adjunta la SCP al root de la organización |

### Servicios habilitados en la organización

- `cloudtrail.amazonaws.com` — auditoría centralizada
- `guardduty.amazonaws.com` — detección de amenazas
- `sso.amazonaws.com` — autenticación mediante IAM Identity Center
- `backup.amazonaws.com` — respaldos centralizados

### Service Control Policy (SCP): DenyForbiddenServices

La SCP se adjunta al root de la organización y aplica a **todas las cuentas y OUs**.

**Bloquea (Deny):**
- `dynamodb:*` — DynamoDB no permitido por ADR-004
- `lambda:*` — Lambda no permitido por ADR-004
- `sqs:*` — SQS no permitido por ADR-004
- `cognito-idp:*`, `cognito-identity:*`, `cognito-sync:*` — Cognito no permitido por ADR-004
- `iam:CreateAccessKey`, `iam:CreateUser` — prohíbe crear usuarios IAM con credenciales de larga duración (excepto el root de la cuenta)

> El bloqueo de `iam:CreateUser` e `iam:CreateAccessKey` garantiza que toda autenticación humana se realice exclusivamente mediante SSO (IAM Identity Center), conforme a la política de identidades de GAITAS.

## Costo estimado

**$0/mes.** AWS Organizations, las OUs y las SCPs no tienen costo adicional.

## Riesgos y consideraciones

| Riesgo | Mitigación |
|---|---|
| La SCP adjunta al root bloquea DynamoDB, Lambda, SQS y Cognito en **toda** la organización, sin excepciones por cuenta | Diseño intencional según ADR-004; si una cuenta necesita una excepción, crear una OU específica y no adjuntar la SCP ahí |
| Bloquear `iam:CreateUser` significa que nadie puede crear usuarios IAM en ninguna cuenta | IAM Identity Center debe estar configurado y operativo **antes** de aplicar esta SCP |
| Las SCPs no afectan al usuario root de cada cuenta | El acceso root de cada cuenta debe protegerse con MFA de hardware |
| `force_destroy = false` en S3 (CloudTrail) — este módulo no crea S3, pero la restricción aplica a recursos dependientes | Documentado para referencia |

## Requisitos previos

1. Cuenta AWS dedicada para management (cuenta raíz de la organización).
2. IAM Identity Center habilitado en la región principal antes de aplicar la SCP de bloqueo de usuarios IAM.
3. Credenciales con permisos `organizations:*` en la cuenta de management.

## Cómo aplicar

```bash
# 1. Configurar credenciales (SSO, no access keys)
aws sso login --profile gaitas-management

# 2. Inicializar el módulo
tofu init

# 3. Revisar el plan
tofu plan -var='entorno=prod' -var='nivel_servicio=critico'

# 4. Aplicar
tofu apply -var='entorno=prod' -var='nivel_servicio=critico'
```

## Variables

| Variable | Tipo | Default | Descripción |
|---|---|---|---|
| `entorno` | string | — | `nonprod` o `prod` |
| `nivel_servicio` | string | `alto` | `critico`, `alto`, `medio` o `bajo` |
| `dueno` | string | `plataforma@laoccidental.com` | Equipo responsable |

## Outputs

| Output | Descripción |
|---|---|
| `organization_id` | ID de la organización (p. ej. `o-xxxxxxxxxxxx`) |
| `root_id` | ID del root (p. ej. `r-xxxx`) |
| `ou_produccion_id` | ID de la OU produccion |
| `ou_nonprod_id` | ID de la OU nonprod |
| `ou_respaldos_id` | ID de la OU respaldos |
| `ou_seguridad_id` | ID de la OU seguridad |
| `scp_deny_forbidden_id` | ID de la SCP de servicios prohibidos |
