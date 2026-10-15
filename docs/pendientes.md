# Pendientes GAITAS — Valores y configuraciones a completar

**Actualizado:** 2026-10-15  
**Responsable:** Equipo de Plataforma / jmperez@laoccidental.com

---

## P-08: Infraestructura AWS (infra/aws/)

Los siguientes valores son `{VALOR}` en los archivos `.tfvars.example` y deben completarse en `terraform.tfvars` (nunca en git) antes del primer `tofu apply`.

### Cuentas AWS

| Variable | Descripción | Archivo |
|----------|-------------|---------|
| `{CUENTA_NONPROD}` | ID de 12 dígitos de la cuenta AWS de nonprod | `envs/nonprod/terraform.tfvars` |
| `{CUENTA_PROD}` | ID de 12 dígitos de la cuenta AWS de producción | `envs/prod/terraform.tfvars` |
| `{CUENTA_MANAGEMENT}` | ID de la cuenta raíz de AWS Organizations | Ambos entornos |
| `{CUENTA_RESPALDOS}` | ID de la cuenta de respaldos/seguridad | Ambos entornos |
| `{CUENTA_SEGURIDAD}` | ID de la cuenta delegada de GuardDuty | Ambos entornos |

### Red / VPN Caracas

| Variable | Descripción |
|----------|-------------|
| `{IP_PUBLICA_CARACAS}` | IP pública del router/firewall en la oficina de Caracas |
| `{CIDR_CARACAS}` | Bloque CIDR de la red privada de Caracas (ej. `192.168.10.0/24`) |

### IAM / Roles

| Variable | Descripción |
|----------|-------------|
| `{VALOR_ROL_SALUD_ARN}` | ARN del rol IAM del módulo de salud (único autorizado a usar la llave KMS datos-salud) |
| `{VALOR_ROL_BACKUP_ARN}` | ARN del rol IAM del servicio de backups |
| `{VALOR_ROL_CI_ARN}` | ARN del rol OIDC para el pipeline de CI (`gaitas-ci-nonprod`) — se crea manualmente una vez |

### Alertas y presupuesto

| Variable | Descripción |
|----------|-------------|
| `{CORREO_ALERTAS}` | Correo(s) que reciben alertas de presupuesto AWS vía SNS |
| Presupuesto nonprod | Límite mensual USD (default: `200`) |
| Presupuesto prod | Límite mensual USD (default: `500`) |

### Secrets de GitHub (repository secrets)

Los secrets deben crearse en el repositorio antes de usar `infra-nonprod.yml`:

| Secret | Valor |
|--------|-------|
| `CUENTA_NONPROD` | ID de cuenta AWS de nonprod |
| `CUENTA_MANAGEMENT` | ID de cuenta de management |
| `CUENTA_RESPALDOS` | ID de cuenta de respaldos |
| `CUENTA_SEGURIDAD` | ID de cuenta de seguridad |
| `IP_PUBLICA_CARACAS` | IP pública de Caracas |
| `CIDR_CARACAS` | CIDR de la red de Caracas |
| `ROL_SALUD_ARN` | ARN del rol de salud |
| `ROL_BACKUP_ARN` | ARN del rol de backups |
| `CORREO_ALERTAS` | Correo de alertas |
| `INFRACOST_API_KEY` | Clave de la API de Infracost (para estimación de costos en CI) |

### Pasos manuales previos al primer apply

1. **Crear la cuenta AWS de nonprod** en AWS Organizations (si no existe).
2. **Aplicar el módulo bootstrap** (`infra/aws/modules/bootstrap/`) con estado local una sola vez para crear el bucket de estado remoto.
3. **Crear el rol OIDC `gaitas-ci-nonprod`** en la cuenta nonprod con trust policy para GitHub Actions (`token.actions.githubusercontent.com`).
4. **Crear el GitHub Environment `nonprod`** con aprobación manual requerida (`Settings → Environments → nonprod`).
5. **Habilitar MFA en la cuenta raíz** de AWS Organizations con dispositivo de hardware.
6. **Configurar IAM Identity Center** apuntando al IdP (Keycloak o directorio corporativo).
7. **Completar todos los secrets** en el repositorio (tabla de arriba).

---

## Otros pendientes del proyecto

| # | Módulo | Descripción |
|---|--------|-------------|
| 1 | actuarial | Conectar dashboards de Margen de Solvencia, PPNC y Cobertura de Reservas al backend real (módulo `actuarial` + `reservas`) |
| 2 | reservas | Implementar Chain Ladder / Bornhuetter-Ferguson para IBNR en el módulo `reservas` |
| 3 | siar | Actualizar textos de Norma 244 SUDESEG (texto normativo oficial) |
| 4 | productos | Integrar cálculo de prima con tarifas SAA reales |
| 5 | cobranza | Credenciales reales de HKA para emisión de facturas electrónicas |
| 6 | portales | Certificados SSL para los dominios de producción |
| 7 | ops | Configurar alertas de Prometheus/Grafana en el cluster EKS |
| 8 | ci/cd | Instalar Argo CD en el cluster EKS nonprod y apuntar al repositorio |
