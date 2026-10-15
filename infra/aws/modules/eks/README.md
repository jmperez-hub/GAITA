# Módulo EKS — GAITAS / La Occidental de Seguros

Crea un clúster Amazon EKS con endpoint **privado exclusivamente**, secrets cifrados con KMS, grupos de nodos administrados y IRSA para el cluster-autoscaler.

---

## Qué crea este módulo

| Recurso | Descripción |
|---|---|
| `aws_eks_cluster` | Clúster EKS, endpoint privado, logs a CloudWatch |
| `aws_iam_role.eks_cluster` | Rol del plano de control |
| `aws_iam_openid_connect_provider` | Proveedor OIDC para IRSA |
| `aws_eks_node_group.general` | Grupo de nodos administrado (ON_DEMAND) |
| `aws_launch_template.nodes` | LT con IMDSv2 obligatorio y disco gp3 cifrado |
| `aws_iam_role.node_group` | Rol de los nodos EC2 |
| `aws_iam_role.cluster_autoscaler` | Rol IRSA para cluster-autoscaler |
| `aws_security_group.eks_cluster` | SG del plano de control |

### Seguridad destacada

- **Endpoint privado**: `endpoint_public_access = false`. El API server sólo es alcanzable desde dentro de la VPC o mediante VPN/AWS VPN Client.
- **Secrets cifrados**: `encryption_config` con la KMS CMK de la plataforma.
- **IMDSv2 obligatorio**: `http_tokens = "required"` en el Launch Template — evita SSRF hacia el metadata service.
- **Discos cifrados**: volúmenes gp3 con la misma KMS CMK.
- **Sin llaves de acceso de larga duración**: todos los accesos son mediante roles IAM (IRSA o rol de instancia).

---

## Variables requeridas

| Variable | Tipo | Descripción |
|---|---|---|
| `vpc_id` | `string` | ID de la VPC |
| `private_subnet_ids` | `list(string)` | Subnets privadas (≥ 2) |
| `kms_key_arn_plataforma` | `string` | ARN KMS CMK |
| `entorno` | `string` | `dev` / `staging` / `prod` |
| `nivel_servicio` | `string` | `critico` / `alto` / `medio` / `bajo` |
| `dueno` | `string` | Email o equipo responsable |

### Variables opcionales con defaults

| Variable | Default | Descripción |
|---|---|---|
| `kubernetes_version` | `"1.31"` | Versión de Kubernetes |
| `instance_types` | `["t3.medium"]` | Tipos de instancia |
| `node_min` | `2` | Nodos mínimos |
| `node_max` | `4` | Nodos máximos |
| `node_desired` | `2` | Nodos deseados al inicio |
| `node_disk_gb` | `50` | Tamaño disco raíz (GiB) |

---

## Uso

```hcl
module "eks" {
  source = "../../modules/eks"

  entorno                = "prod"
  nivel_servicio         = "critico"
  dueno                  = "plataforma@laoccidental.com"
  vpc_id                 = "{VALOR_VPC_ID}"
  private_subnet_ids     = ["{VALOR_SUBNET_1}", "{VALOR_SUBNET_2}", "{VALOR_SUBNET_3}"]
  kms_key_arn_plataforma = "{VALOR_KMS_ARN}"

  kubernetes_version = "1.31"
  instance_types     = ["t3.medium"]
  node_min           = 2
  node_max           = 4
  node_desired       = 2
  node_disk_gb       = 50
}
```

---

## IRSA para cluster-autoscaler

Tras aplicar el módulo, anota el ServiceAccount de Kubernetes con el ARN del rol:

```bash
kubectl annotate serviceaccount cluster-autoscaler \
  -n kube-system \
  eks.amazonaws.com/role-arn=$(tofu output -raw cluster_autoscaler_role_arn)
```

Helm values mínimos:

```yaml
autoDiscovery:
  clusterName: gaitas-prod
awsRegion: us-east-1
rbac:
  serviceAccount:
    annotations:
      eks.amazonaws.com/role-arn: "{VALOR_AUTOSCALER_ROLE_ARN}"
```

---

## Conectarse al clúster

El endpoint es **privado**. Se requiere VPN o AWS VPN Client conectado a la VPC, o acceso a través de un bastion con AWS Systems Manager Session Manager.

```bash
# Desde una máquina dentro de la VPC o con VPN activa
aws eks update-kubeconfig \
  --region us-east-1 \
  --name gaitas-prod \
  --alias gaitas-prod
```

**No hay acceso público al API server.** Cualquier intento desde internet será rechazado a nivel de red.

---

## Estimación de costos (us-east-1, ON_DEMAND)

| Componente | Costo aprox./mes |
|---|---|
| Control plane EKS | $73.00 |
| 2 × t3.medium (nodos base) | $60.10 |
| 2 × disco gp3 50 GiB | $8.00 |
| CloudWatch Logs (logs del clúster) | ~$5.00 |
| **Total estimado (2 nodos)** | **~$146/mes** |

Con 4 nodos (node_max) el costo de EC2 escala a ~$120/mes en nodos.  
Los costos no incluyen tráfico de datos, ECR ni otros servicios de la carga de trabajo.

---

## Outputs clave

| Output | Uso |
|---|---|
| `cluster_name` | Nombre del clúster para `aws eks update-kubeconfig` |
| `cluster_endpoint` | Endpoint privado del API server |
| `oidc_provider_arn` | Para crear roles IRSA adicionales |
| `cluster_autoscaler_role_arn` | Anotar en el ServiceAccount del autoscaler |
| `cluster_certificate_authority_data` | CA para kubeconfig (sensitive) |
