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
  default     = "alto"
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
