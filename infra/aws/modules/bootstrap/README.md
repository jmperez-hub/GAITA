# Módulo Bootstrap — GAITAS / La Occidental de Seguros

Crea el bucket S3 que actúa como backend de estado remoto para todos los módulos OpenTofu/Terraform del proyecto GAITAS. **Se aplica una sola vez por entorno**, con estado local, antes de que exista cualquier infraestructura.

---

## Qué crea este módulo

| Recurso | Descripción |
|---|---|
| `aws_s3_bucket` | Bucket de estado remoto (`gaitas-tofu-estado-<cuenta_id>`) |
| `aws_s3_bucket_versioning` | Versioning habilitado — permite recuperar estados anteriores |
| `aws_s3_bucket_server_side_encryption_configuration` | Cifrado SSE-KMS con CMK dedicada y Bucket Key |
| `aws_s3_bucket_public_access_block` | Bloqueo total de acceso público |
| `aws_s3_bucket_lifecycle_configuration` | Expiración de versiones no-actuales a 90 días |
| `aws_s3_bucket_policy` | Deniega HTTP plano; permite acceso sólo al rol CI |
| `aws_kms_key` | CMK con rotación anual automática, ventana de eliminación de 30 días |
| `aws_kms_alias` | Alias `alias/gaitas-tofu-estado-<entorno>` |

---

## Locking nativo S3 (sin DynamoDB)

A partir de **OpenTofu ≥ 1.10**, el backend `s3` soporta bloqueo nativo mediante un archivo de lock en el propio bucket. No se requiere tabla DynamoDB.

Configura el backend en cada entorno así:

```hcl
terraform {
  backend "s3" {
    bucket       = "gaitas-tofu-estado-{VALOR_CUENTA_ID}"
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    kms_key_id   = "{VALOR_KMS_KEY_ID}"
    use_lockfile = true   # Requiere OpenTofu >= 1.10 — lock nativo S3
  }
}
```

El archivo de lock se escribe como `<key>.tflock` en el mismo bucket. Si una operación falla a mitad de camino, el lock queda y puede forzarse con `tofu force-unlock <lock-id>`.

---

## Cómo aplicar (una sola vez por entorno)

```bash
# 1. Ir al directorio del entorno que usa este módulo
cd infra/aws/envs/prod/bootstrap

# 2. Inicializar sin backend remoto (estado local)
tofu init -backend=false

# 3. Revisar el plan
tofu plan -var="entorno=prod" \
          -var="cuenta_id={VALOR_CUENTA_ID}" \
          -var="nivel_servicio=critico" \
          -var="dueno=plataforma@laoccidental.com" \
          -var="rol_ci_arn={VALOR_ROL_CI_ARN}"

# 4. Aplicar
tofu apply -var="entorno=prod" \
           -var="cuenta_id={VALOR_CUENTA_ID}" \
           -var="nivel_servicio=critico" \
           -var="dueno=plataforma@laoccidental.com" \
           -var="rol_ci_arn={VALOR_ROL_CI_ARN}"

# 5. (Opcional pero recomendado) Migrar el estado local al bucket recién creado
tofu state push terraform.tfstate
```

Después de `tofu state push`, actualiza la configuración del backend en el `terraform {}` block y vuelve a hacer `tofu init` para conectar al backend remoto.

---

## Variables

| Variable | Tipo | Requerida | Descripción |
|---|---|---|---|
| `entorno` | `string` | Sí | `dev` / `staging` / `prod` |
| `nivel_servicio` | `string` | Sí | `critico` / `alto` / `medio` / `bajo` |
| `dueno` | `string` | Sí | Email o equipo responsable |
| `cuenta_id` | `string` | Sí | ID de 12 dígitos de la cuenta AWS |
| `rol_ci_arn` | `string` | No | ARN del rol OIDC de CI (default: `{VALOR_ROL_CI_ARN}`) |

---

## Outputs

| Output | Uso |
|---|---|
| `bucket_name` | Nombre del bucket para la config del backend `s3` |
| `bucket_arn` | ARN para políticas de otros recursos |
| `kms_key_arn` | ARN completo de la CMK |
| `kms_key_id` | ID corto de la CMK, para `kms_key_id` en el backend |

---

## Estimación de costos

| Componente | Costo aprox./mes |
|---|---|
| S3 almacenamiento (< 1 GB de estados) | $0.023/GB = < $0.05 |
| S3 operaciones (PUT/GET de state) | < $0.01 |
| KMS CMK | $1.00/mes por llave |
| KMS llamadas API (rotación, cifrado) | < $0.10 |
| **Total estimado** | **~$1.15/mes** |

---

## Seguridad

- Todo el acceso al bucket es **HTTPS obligatorio** (política `DenyNonTLS`).
- **Sin usuarios IAM con llaves de acceso**: el único principal autorizado es el rol OIDC del CI.
- La CMK tiene **rotación automática anual** y ventana de eliminación de 30 días.
- El versioning permite **recuperación ante borrado accidental** del estado.
- El acceso público al bucket está **completamente bloqueado** en los cuatro ejes del Block Public Access.
