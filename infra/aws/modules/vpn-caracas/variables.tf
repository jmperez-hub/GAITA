# vpn-caracas/variables.tf

variable "entorno" {
  type        = string
  description = "Nombre del entorno de despliegue (nonprod, prod, etc.)"
  validation {
    condition     = contains(["nonprod", "staging", "prod"], var.entorno)
    error_message = "El entorno debe ser uno de: nonprod, staging, prod."
  }
}

variable "nivel_servicio" {
  type        = string
  description = "Nivel de servicio del recurso (critico, alto, medio, bajo)"
  validation {
    condition     = contains(["critico", "alto", "medio", "bajo"], var.nivel_servicio)
    error_message = "El nivel de servicio debe ser uno de: critico, alto, medio, bajo."
  }
}

variable "dueno" {
  type        = string
  description = "Equipo o persona responsable del recurso (ej. plataforma, redes)"
}

variable "vpc_id" {
  type        = string
  description = "ID de la VPC GAITAS a la que se adjunta el Virtual Private Gateway"
  validation {
    condition     = can(regex("^vpc-[0-9a-f]+$", var.vpc_id))
    error_message = "El vpc_id debe tener el formato vpc-xxxxxxxx."
  }
}

variable "ip_publica_caracas" {
  type        = string
  description = "Dirección IP pública del router/firewall del datacenter de Caracas"
  default     = "{IP_PUBLICA_CARACAS}"
  validation {
    condition     = can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", var.ip_publica_caracas)) || var.ip_publica_caracas == "{IP_PUBLICA_CARACAS}"
    error_message = "La ip_publica_caracas debe ser una dirección IPv4 válida o el placeholder {IP_PUBLICA_CARACAS}."
  }
}

variable "bgp_asn_caracas" {
  type        = number
  description = "Número ASN BGP del equipo on-premises en Caracas (65000–65535 para ASN privado)"
  default     = 65000
  validation {
    condition     = var.bgp_asn_caracas >= 1 && var.bgp_asn_caracas <= 65535
    error_message = "El bgp_asn_caracas debe estar entre 1 y 65535."
  }
}

variable "cidr_caracas" {
  type        = list(string)
  description = "Lista de bloques CIDR de la red on-premises de Caracas para rutas estáticas"
  default     = ["{CIDR_CARACAS}"]
  validation {
    condition     = length(var.cidr_caracas) > 0
    error_message = "Se debe especificar al menos un bloque CIDR para la red de Caracas."
  }
}

variable "route_table_privada_id" {
  type        = string
  description = "ID de la tabla de rutas de las subredes privadas (output del módulo network) para la propagación de rutas VPN"
  validation {
    condition     = can(regex("^rtb-[0-9a-f]+$", var.route_table_privada_id))
    error_message = "El route_table_privada_id debe tener el formato rtb-xxxxxxxx."
  }
}
