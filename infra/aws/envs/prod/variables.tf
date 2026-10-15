variable "region" {
  description = "Región AWS principal"
  type        = string
  default     = "us-east-1"
}

variable "cuenta_prod" {
  description = "ID de la cuenta AWS de producción (12 dígitos)"
  type        = string
  default     = "{CUENTA_PROD}"
  validation {
    condition     = can(regex("^[0-9]{12}$", var.cuenta_prod)) || var.cuenta_prod == "{CUENTA_PROD}"
    error_message = "cuenta_prod debe ser un ID de cuenta AWS de 12 dígitos."
  }
}

variable "cuenta_management" {
  description = "ID de la cuenta de management/root de la organización"
  type        = string
  default     = "{CUENTA_MANAGEMENT}"
}

variable "cuenta_respaldos" {
  description = "ID de la cuenta de respaldos"
  type        = string
  default     = "{CUENTA_RESPALDOS}"
}

variable "cuenta_seguridad" {
  description = "ID de la cuenta de seguridad"
  type        = string
  default     = "{CUENTA_SEGURIDAD}"
}

variable "vpc_cidr" {
  description = "CIDR de la VPC de producción"
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zones" {
  description = "Lista de AZs para la VPC (mínimo 2)"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "kubernetes_version" {
  description = "Versión de Kubernetes para EKS"
  type        = string
  default     = "1.31"
}

variable "ip_publica_caracas" {
  description = "IP pública del gateway de la oficina de Caracas"
  type        = string
  default     = "{IP_PUBLICA_CARACAS}"
}

variable "bgp_asn_caracas" {
  description = "ASN BGP del customer gateway de Caracas"
  type        = number
  default     = 65000
}

variable "cidr_caracas" {
  description = "Bloques CIDR de la red privada de Caracas"
  type        = list(string)
  default     = ["{CIDR_CARACAS}"]
}

variable "rol_salud_arn" {
  description = "ARN del rol IAM del módulo de salud"
  type        = string
  default     = "{VALOR_ROL_SALUD_ARN}"
}

variable "rol_backup_arn" {
  description = "ARN del rol IAM del servicio de backups"
  type        = string
  default     = "{VALOR_ROL_BACKUP_ARN}"
}

variable "correos_alerta" {
  description = "Correos para alertas de presupuesto"
  type        = list(string)
  default     = ["{CORREO_ALERTAS}"]
}

variable "presupuesto_mensual_usd" {
  description = "Límite mensual de costo en USD para la cuenta prod"
  type        = string
  default     = "500"
}

variable "dueno" {
  description = "Equipo o persona responsable"
  type        = string
  default     = "plataforma@laoccidental.com"
}
