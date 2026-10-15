# GAITAS — Infraestructura AWS (OpenTofu)

Base de infraestructura cloud de GAITAS para La Occidental de Seguros.  
Código de infraestructura como código con OpenTofu ≥ 1.10.

---

## Estructura

```
infra/aws/
├── versions.tf               # Versiones requeridas (OpenTofu ≥ 1.10, aws ~> 5)
├── .checkov.yaml             # Políticas de seguridad (hard-fail en cifrado, logging, público)
├── modules/
│   ├── bootstrap/            # Bucket de estado remoto — aplicar UNA SOLA VEZ
│   ├── organizations/        # OUs, SCP: sin DynamoDB/Lambda/SQS/Cognito, sin claves IAM largas
│   ├── identity-center/      # SSO (IAM Identity Center), permission sets
│   ├── cloudtrail/           # Trail organizacional → bucket Object Lock 7 años (Art. 67 LSIB)
│   ├── guardduty/            # GuardDuty organizacional, delegado en cuenta seguridad
│   ├── kms/                  # Llaves: plataforma, respaldos, datos-salud (separada, ADR-004 regla 8)
│   ├── network/              # VPC 2 AZ, subredes privadas, endpoints S3/ECR/STS, 1 NAT
│   ├── eks/                  # EKS sin endpoint público, KMS secretos, IRSA autoscaler
│   ├── backups-bucket/       # S3 Object Lock COMPLIANCE 7 años, KMS respaldos
│   ├── vpn-caracas/          # VPN sitio a sitio hacia datacenter Caracas
│   └── budgets/              # Presupuestos mensuales por cuenta + alertas SNS
└── envs/
    ├── nonprod/              # main.tf compone los módulos; tfvars de ejemplo
    └── prod/                 # Misma composición — SIN workflow de apply en F0
```

---

## Principios (ADR-004)

- **Sin lock-in:** No DynamoDB, Lambda, SQS, Cognito — SCP los bloquea en toda la organización.
- **Sin claves IAM largas:** Solo SSO vía IAM Identity Center + OIDC efímero para CI/CD.
- **Estado remoto sin DynamoDB:** `use_lockfile = true` (bloqueo nativo S3, OpenTofu ≥ 1.10).
- **Datos de salud aislados:** Llave KMS `datos-salud` separada, política restrictiva, nunca en CloudTrail.
- **10 años de conservación digital (Art. 67 LSIB):** Object Lock COMPLIANCE 7 años en backups y CloudTrail (renovable).

---

## Orden de aplicación

### 1. Bootstrap (una sola vez por entorno)

```bash
cd infra/aws/modules/bootstrap
cp terraform.tfvars.example terraform.tfvars
# Completar: cuenta_id, rol_ci_arn
tofu init -backend=false
tofu plan
tofu apply
# Mover el estado al bucket recién creado:
tofu init -migrate-state
```

### 2. Nonprod (desde el pipeline)

El apply de nonprod se ejecuta **solo** desde el workflow `infra-nonprod.yml` con `workflow_dispatch`.  
**Nadie aplica manualmente.** El workflow requiere:

1. Aprobación en el GitHub Environment `nonprod` (crear en `Settings → Environments`).
2. Ingresar `aplicar-nonprod` en el campo de confirmación.
3. Credenciales vía OIDC (rol `gaitas-ci-nonprod`) — nunca claves estáticas.

```bash
# No ejecutar manualmente. Usar el pipeline:
# .github/workflows/infra-nonprod.yml → workflow_dispatch
```

### 3. Prod

Sin workflow de apply en F0. El entorno `prod/` está definido para planificación.  
El hook `proteger-rutas` bloquea push a `infra/*/prod/*` directamente.

---

## Prerrequisitos

Completar todos los `{VALOR}` en `envs/nonprod/terraform.tfvars` (copiar de `terraform.tfvars.example`).  
Ver `docs/pendientes.md` para la lista completa.

**Secrets de GitHub requeridos:**  
`CUENTA_NONPROD`, `CUENTA_MANAGEMENT`, `CUENTA_RESPALDOS`, `CUENTA_SEGURIDAD`,  
`IP_PUBLICA_CARACAS`, `CIDR_CARACAS`, `ROL_SALUD_ARN`, `ROL_BACKUP_ARN`,  
`CORREO_ALERTAS`, `INFRACOST_API_KEY`

---

## Verificación local

```bash
# Formato
tofu fmt -check -recursive

# Validar (sin backend)
cd envs/nonprod && tofu init -backend=false && tofu validate

# Seguridad
checkov --directory . --config-file .checkov.yaml

# Confirmar que no hay servicios prohibidos en código de producción:
grep -ri "dynamodb\|lambda\|sqs\|cognito" . \
  --include="*.tf" \
  --exclude-dir=".terraform"
# Solo debe aparecer en modules/organizations/main.tf (la SCP que los prohíbe)
```

---

## Costo estimado (nonprod, us-east-1)

| Componente | USD/mes |
|------------|---------|
| NAT Gateway (1) | ~$32 |
| VPC Endpoints (ECR API, ECR DKR, STS) | ~$21 |
| EKS control plane | ~$73 |
| Nodos t3.medium × 2 | ~$60 |
| KMS keys × 3 | ~$3 |
| CloudTrail + S3 | ~$5 |
| VPN sitio a sitio | ~$36 |
| GuardDuty | ~$15 |
| **Total estimado** | **~$245/mes** |

Los costos reales dependen del tráfico y del uso. Configurar `INFRACOST_API_KEY` para estimaciones precisas en CI.
