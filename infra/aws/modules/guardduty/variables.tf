variable "entorno" {
  description = "Entorno de despliegue: nonprod o prod"
  type        = string
  validation {
    condition     = contains(["nonprod", "prod"], var.entorno)
    error_message = "entorno debe ser nonprod o prod."
  }
}

variable "nivel_servicio" {
  description = "Nivel de servicio SLA: critico, alto, medio, bajo"
  type        = string
  default     = "critico"
  validation {
    condition     = contains(["critico", "alto", "medio", "bajo"], var.nivel_servicio)
    error_message = "nivel_servicio debe ser critico, alto, medio o bajo."
  }
}

variable "dueno" {
  description = "Equipo o persona responsable del recurso"
  type        = string
  default     = "plataforma@laoccidental.com"
}

variable "cuenta_seguridad" {
  description = "ID de la cuenta AWS de seguridad designada como administrador delegado de GuardDuty para la organización (p. ej. {ACCOUNT_ID_SEGURIDAD})"
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.cuenta_seguridad))
    error_message = "cuenta_seguridad debe ser un ID de cuenta AWS de 12 dígitos."
  }
}
