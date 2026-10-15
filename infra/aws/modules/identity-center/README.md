# Módulo: identity-center

Configura IAM Identity Center (SSO) para la plataforma GAITAS de La Occidental de Seguros. No crea usuarios IAM con credenciales de larga duración — toda autenticación humana se realiza exclusivamente mediante SSO.

## Qué crea

| Recurso | Nombre | Descripción |
|---|---|---|
| `aws_ssoadmin_permission_set` | `AdministradorPlataforma` | Acceso completo (AdministratorAccess), sesión 8 h |
| `aws_ssoadmin_managed_policy_attachment` | — | Adjunta `AdministratorAccess` al set anterior |
| `aws_ssoadmin_permission_set` | `DesarrolladorLectura` | Solo lectura (ReadOnlyAccess), sesión 8 h |
| `aws_ssoadmin_managed_policy_attachment` | — | Adjunta `ReadOnlyAccess` al set anterior |
| `aws_ssoadmin_permission_set` | `AuditorSeguridad` | Auditoría (SecurityAudit), sesión 4 h |
| `aws_ssoadmin_managed_policy_attachment` | — | Adjunta `SecurityAudit` al set anterior |

### Permission sets y políticas

| Permission Set | Política AWS Managed | Duración de sesión | Uso |
|---|---|---|---|
| `AdministradorPlataforma` | `AdministratorAccess` | 8 horas | Equipo de plataforma e infraestructura |
| `DesarrolladorLectura` | `ReadOnlyAccess` | 8 horas | Desarrolladores con acceso de solo lectura a prod |
| `AuditorSeguridad` | `SecurityAudit` | 4 horas | Auditores internos y externos |

> La sesión de `AuditorSeguridad` se limita a 4 horas por política de menor privilegio para accesos de auditoría.

## Costo estimado

**$0/mes.** IAM Identity Center (antes AWS SSO) no tiene costo adicional en ninguna región.

## Riesgos y consideraciones

| Riesgo | Mitigación |
|---|---|
| IAM Identity Center debe habilitarse manualmente en la consola de AWS antes de ejecutar este módulo | Verificar que la instancia SSO exista con `aws sso-admin list-instances` antes de aplicar |
| Sin SSO configurado, nadie puede acceder a las cuentas (si la SCP del módulo `organizations` ya bloquea `iam:CreateUser`) | Aplicar este módulo **antes** de activar la SCP de organizations, o tener acceso root de cuenta disponible |
| `AdministradorPlataforma` otorga `AdministratorAccess` completo | Asignar únicamente a usuarios del equipo de plataforma; revisar asignaciones trimestralmente |
| Los permission sets no tienen MFA forzado a nivel de recurso Terraform | Habilitar MFA requerido en la configuración de la instancia SSO desde la consola de AWS o mediante `aws_ssoadmin_instance_access_control_attributes` |

## Cómo asignar usuarios y grupos

La asignación de usuarios o grupos a permission sets y cuentas se realiza fuera de este módulo, directamente en la consola de AWS o mediante recursos adicionales de Terraform.

### Desde la consola de AWS

1. Ir a **IAM Identity Center** → **AWS accounts**.
2. Seleccionar la cuenta y hacer clic en **Assign users or groups**.
3. Seleccionar el grupo o usuario del Identity Store.
4. Seleccionar el permission set (`AdministradorPlataforma`, `DesarrolladorLectura` o `AuditorSeguridad`).
5. Hacer clic en **Submit**.

### Desde Terraform (ejemplo adicional)

```hcl
resource "aws_ssoadmin_account_assignment" "ejemplo" {
  instance_arn       = module.identity_center.sso_instance_arn
  permission_set_arn = module.identity_center.desarrollador_lectura_arn
  principal_id       = "{GRUPO_ID_EN_IDENTITY_STORE}"
  principal_type     = "GROUP"
  target_id          = "{ACCOUNT_ID}"
  target_type        = "AWS_ACCOUNT"
}
```

## Requisitos previos

1. IAM Identity Center habilitado en la cuenta de management (solo puede existir una instancia por organización).
2. Proveedor de identidades externo (p. ej. Azure AD, Okta) configurado en IAM Identity Center si se desea federación.
3. Credenciales con permisos `sso-admin:*` e `identitystore:*` en la cuenta de management.

## Cómo aplicar

```bash
# 1. Verificar que la instancia SSO existe
aws sso-admin list-instances --region us-east-1

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
| `sso_instance_arn` | ARN de la instancia de IAM Identity Center |
| `sso_instance_id` | ID del Identity Store |
| `admin_plataforma_arn` | ARN del permission set AdministradorPlataforma |
| `desarrollador_lectura_arn` | ARN del permission set DesarrolladorLectura |
| `auditor_seguridad_arn` | ARN del permission set AuditorSeguridad |
