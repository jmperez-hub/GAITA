# kms/variables.tf

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

variable "cuenta_id" {
  type        = string
  description = "ID numérico de la cuenta AWS donde se despliegan los recursos (12 dígitos)"
  validation {
    condition     = can(regex("^[0-9]{12}$", var.cuenta_id))
    error_message = "El cuenta_id debe ser un número de 12 dígitos."
  }
}

variable "rol_salud_arn" {
  type        = string
  description = "ARN del rol IAM del módulo de salud con permiso para usar la llave datos-salud"
  default     = "{VALOR_ROL_SALUD_ARN}"
  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/.+$", var.rol_salud_arn)) || var.rol_salud_arn == "{VALOR_ROL_SALUD_ARN}"
    error_message = "El rol_salud_arn debe ser un ARN válido de rol IAM o el placeholder {VALOR_ROL_SALUD_ARN}."
  }
}
