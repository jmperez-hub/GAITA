# network/variables.tf

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
  description = "Equipo o persona responsable del recurso (ej. plataforma, seguridad)"
}

variable "region" {
  type        = string
  description = "Región AWS donde se despliega la VPC"
  default     = "us-east-1"
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "La región debe tener el formato AWS estándar (ej. us-east-1)."
  }
}

variable "vpc_cidr" {
  type        = string
  description = "Bloque CIDR principal de la VPC (ej. 10.0.0.0/16)"
  default     = "10.0.0.0/16"
  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "El vpc_cidr debe ser un bloque CIDR válido."
  }
}

variable "availability_zones" {
  type        = list(string)
  description = "Lista de zonas de disponibilidad para las subredes (mínimo 2)"
  default     = ["us-east-1a", "us-east-1b"]
  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "Se requieren al menos 2 zonas de disponibilidad."
  }
}

variable "kms_key_arn_plataforma" {
  type        = string
  description = "ARN de la llave KMS de plataforma para cifrar los Flow Logs en CloudWatch"
  validation {
    condition     = can(regex("^arn:aws:kms:.+:[0-9]{12}:key/.+$", var.kms_key_arn_plataforma))
    error_message = "El kms_key_arn_plataforma debe ser un ARN válido de llave KMS."
  }
}
