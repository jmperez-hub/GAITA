# Módulo Network — GAITAS

Despliega la VPC base del proyecto GAITAS con diseño private-only (sin subredes públicas para cargas de trabajo), NAT gateway, endpoints VPC y Flow Logs.

## Diseño de la VPC

```
┌─────────────────────────────────────────────────────────────────┐
│  VPC gaitas (10.0.0.0/16)                                       │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────┐            │
│  │ Subred privada AZ-a  │  │ Subred privada AZ-b  │            │
│  │ (cargas EKS, RDS…)   │  │ (cargas EKS, RDS…)   │            │
│  └──────────┬───────────┘  └──────────┬───────────┘            │
│             │ → Route table privada   │                          │
│             └────────────┬────────────┘                         │
│                          │ 0.0.0.0/0 → NAT GW                  │
│  ┌───────────────────────▼───────────────────────┐             │
│  │          Subred NAT (AZ-a solamente)           │             │
│  │          aws_nat_gateway.gaitas                │             │
│  └───────────────────────┬───────────────────────┘             │
│                          │ → IGW → Internet                     │
└──────────────────────────┼──────────────────────────────────────┘
                           ▼
                     Internet Gateway
```

### Subredes creadas

| Tipo | AZ | CIDR (con vpc_cidr=10.0.0.0/16) | Propósito |
|---|---|---|---|
| Privada | us-east-1a | 10.0.0.0/20 | EKS nodes, RDS, ALB interno |
| Privada | us-east-1b | 10.0.16.0/20 | EKS nodes, RDS, ALB interno |
| NAT | us-east-1a | 10.0.128.0/20 | NAT gateway solamente |
| NAT | us-east-1b | 10.0.144.0/20 | NAT gateway solamente (sin GW propio) |

Las subredes privadas llevan tags `kubernetes.io/role/internal-elb=1` para que EKS pueda crear Load Balancers internos automáticamente.

## VPC Endpoints

| Endpoint | Tipo | Costo | Propósito |
|---|---|---|---|
| S3 | Gateway | Gratis | Pull de artefactos, escritura de logs |
| ECR API | Interface | ~$7.30/mes | Autenticación ECR desde EKS |
| ECR Docker | Interface | ~$7.30/mes | Pull de imágenes de contenedor |
| STS | Interface | ~$7.30/mes | AssumeRole desde pods (IRSA) |

Los endpoints de interfaz usan `private_dns_enabled = true` para que el DNS interno de la VPC resuelva los nombres de servicio de AWS a IPs privadas sin cambios en la aplicación.

## Flow Logs

Los Flow Logs capturan todo el tráfico (`ACCEPT`, `REJECT`, metadata) y los almacena en CloudWatch Logs `/gaitas/vpc/flow-logs/{entorno}` con:
- Retención: 90 días
- Cifrado: llave KMS de plataforma (`var.kms_key_arn_plataforma`)
- Rol IAM dedicado `gaitas-vpc-flow-logs-{entorno}` con permisos mínimos

## Estimación de costos (us-east-1, octubre 2026)

| Recurso | Costo mensual |
|---|---|
| NAT Gateway (744 h × $0.045/h) | ~$33.48 |
| NAT data processing (estimado 50 GB × $0.045) | ~$2.25 |
| ECR API endpoint (2 AZ × $0.01/h × 744 h) | ~$14.88 |
| ECR Docker endpoint (2 AZ × $0.01/h × 744 h) | ~$14.88 |
| STS endpoint (2 AZ × $0.01/h × 744 h) | ~$14.88 |
| S3 Gateway endpoint | $0.00 |
| VPC Flow Logs → CloudWatch Logs (estimado) | ~$5.00 |
| **Total estimado** | **~$85/mes** |

> Nota: el costo real depende del volumen de datos transferidos por el NAT y de las llamadas API a los endpoints de interfaz.

## Riesgos conocidos

### NAT gateway único (SPOF en nonprod)
El módulo despliega un solo NAT gateway en la primera AZ para reducir costos en ambientes no productivos. Si esa AZ tiene una interrupción, todas las subredes privadas pierden acceso a internet.

**Para producción:** activar un NAT gateway por AZ usando el patrón siguiente:

```hcl
# En entorno prod, descomentar y adaptar:
# resource "aws_eip" "nat" {
#   for_each = toset(var.availability_zones)
#   domain   = "vpc"
#   tags     = merge(local.tags, { Name = "gaitas-nat-eip-${each.key}" })
# }
#
# resource "aws_nat_gateway" "gaitas" {
#   for_each      = { for i, az in var.availability_zones : az => i }
#   allocation_id = aws_eip.nat[each.key].id
#   subnet_id     = aws_subnet.nat[each.key].id
#   ...
# }
```

Cada AZ adicional agrega ~$33/mes.

### Default Security Group sin reglas
El recurso `aws_default_security_group.gaitas` se gestiona con OpenTofu para que no quede con las reglas permisivas por defecto. Esto cumple el control CIS AWS 5.4. Si algún servicio AWS lo usa implícitamente, podría fallar; en ese caso crear un SG explícito para ese servicio.

## Uso

```hcl
module "network" {
  source                 = "../modules/network"
  entorno                = "nonprod"
  nivel_servicio         = "alto"
  dueno                  = "plataforma"
  region                 = "us-east-1"
  vpc_cidr               = "10.0.0.0/16"
  availability_zones     = ["us-east-1a", "us-east-1b"]
  kms_key_arn_plataforma = module.kms.plataforma_key_arn
}
```

## Outputs principales

- `vpc_id` — requerido por módulos EKS, RDS, VPN
- `private_subnet_ids` — requerido por módulos EKS, RDS
- `route_table_privada_id` — requerido por el módulo `vpn-caracas` para propagación de rutas
