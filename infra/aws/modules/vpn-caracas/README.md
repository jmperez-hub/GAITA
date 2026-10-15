# Módulo VPN Caracas — GAITAS

Establece una conexión VPN Site-to-Site entre la cuenta AWS de GAITAS y el datacenter on-premises de La Occidental de Seguros en Caracas.

## Arquitectura

```
┌──────────────────────────┐          ┌──────────────────────────┐
│   AWS VPC GAITAS         │          │   Datacenter Caracas     │
│                          │          │                          │
│  aws_vpn_gateway.gaitas  │◄──────►  │  Router / Firewall       │
│  (Virtual Private GW)    │  IKEv2   │  IP: {IP_PUBLICA_CARACAS}│
│                          │  AES256  │  ASN: 65000 (defecto)    │
│  Route propagation →     │          │                          │
│  route_table_privada     │          │  Redes: {CIDR_CARACAS}   │
└──────────────────────────┘          └──────────────────────────┘
```

## Componentes creados

| Recurso | Nombre | Propósito |
|---|---|---|
| `aws_customer_gateway` | `gaitas-cgw-caracas` | Representa el router on-prem de Caracas en AWS |
| `aws_vpn_gateway` | `gaitas-vgw-{entorno}` | Gateway en la VPC que termina los túneles |
| `aws_vpn_connection` | `gaitas-vpn-caracas-{entorno}` | Conexión VPN con 2 túneles en alta disponibilidad |
| `aws_vpn_connection_route` | (uno por CIDR) | Rutas estáticas hacia Caracas |
| `aws_vpn_gateway_route_propagation` | — | Propaga rutas VPN a la tabla de rutas privada |

## Parámetros de cifrado (IKEv2)

| Parámetro | Valor |
|---|---|
| IKE Version | IKEv2 |
| Phase 1 DH Group | 20 (ECP-384) |
| Phase 2 DH Group | 20 (ECP-384) |
| Phase 1 Encryption | AES-256 |
| Phase 2 Encryption | AES-256-GCM-16 |
| Routing | Estático (no BGP) |

Estos parámetros cumplen los requerimientos mínimos de la circular SUDEBAN para conexiones seguras (AES-256, IKEv2).

## Rutas estáticas

El módulo crea una `aws_vpn_connection_route` por cada elemento en `var.cidr_caracas` y propaga esas rutas a la tabla de rutas privada de la VPC mediante `aws_vpn_gateway_route_propagation`. Los pods de EKS y las instancias en subredes privadas pueden alcanzar las redes de Caracas sin configuración adicional.

## Estimación de costos (us-east-1)

| Recurso | Costo mensual |
|---|---|
| VPN Connection (744 h × $0.05/h) | ~$37.20 |
| Data transfer saliente (estimado 100 GB × $0.09) | ~$9.00 |
| **Total estimado** | **~$46/mes** |

> Nota: el Virtual Private Gateway no tiene costo propio; se cobra por la VPN Connection.

## Configuración del equipo on-premises (Caracas)

Después de aplicar el módulo, recuperar los outputs para configurar el lado Caracas:

```bash
tofu output -module vpn_caracas tunnel1_address
tofu output -module vpn_caracas tunnel2_address
```

Parámetros a configurar en el router/firewall de Caracas:

1. **Peer remoto (túnel 1):** IP del output `tunnel1_address`
2. **Peer remoto (túnel 2):** IP del output `tunnel2_address` (redundancia)
3. **Pre-shared key:** AWS genera una PSK aleatoria por túnel. Descargar la configuración completa desde la consola AWS VPN → *Download Configuration* seleccionando el fabricante del router.
4. **Red local (Caracas):** `var.cidr_caracas`
5. **Red remota (AWS):** `var.vpc_cidr` (ej. 10.0.0.0/16)
6. **IKE Version:** IKEv2
7. **DH Group:** 20
8. **Cifrado:** AES-256 (Phase 1), AES-256-GCM-16 (Phase 2)
9. **Lifetime Phase 1:** 28800 s (defecto AWS)
10. **Lifetime Phase 2:** 3600 s (defecto AWS)

## Prerequisitos

- Módulo `network` aplicado previamente (necesita `vpc_id` y `route_table_privada_id`)
- IP pública estática del lado Caracas conocida antes de aplicar
- Acceso a la consola o CLI del router/firewall de Caracas para configurar los túneles

## Uso

```hcl
module "vpn_caracas" {
  source                 = "../modules/vpn-caracas"
  entorno                = "prod"
  nivel_servicio         = "critico"
  dueno                  = "redes"
  vpc_id                 = module.network.vpc_id
  route_table_privada_id = module.network.route_table_privada_id
  ip_publica_caracas     = "{IP_PUBLICA_CARACAS}"
  bgp_asn_caracas        = 65000
  cidr_caracas           = ["{CIDR_CARACAS_1}", "{CIDR_CARACAS_2}"]
}
```
