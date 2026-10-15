# budgets/variables.tf

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
  description = "Equipo o persona responsable del recurso (ej. finanzas, plataforma)"
}

variable "kms_key_arn_plataforma" {
  type        = string
  description = "ARN de la llave KMS de plataforma para cifrar el tópico SNS de alertas"
  validation {
    condition     = can(regex("^arn:aws:kms:.+:[0-9]{12}:key/.+$", var.kms_key_arn_plataforma))
    error_message = "El kms_key_arn_plataforma debe ser un ARN válido de llave KMS."
  }
}

variable "correos_alerta" {
  type        = list(string)
  description = "Lista de correos electrónicos que reciben alertas de presupuesto"
  default     = ["{CORREO_ALERTAS}"]
  validation {
    condition     = length(var.correos_alerta) > 0
    error_message = "Se debe especificar al menos un correo de alerta."
  }
}

variable "limites_por_cuenta" {
  type        = map(string)
  description = "Mapa de nombre de cuenta o perfil → límite mensual en USD (valor como string, ej. '200'). Se crea un budget por cada entrada."
  default = {
    "nonprod" = "200"
    "prod"    = "500"
  }
  validation {
    condition     = alltrue([for v in values(var.limites_por_cuenta) : can(tonumber(v)) && tonumber(v) > 0])
    error_message = "Todos los valores de limites_por_cuenta deben ser strings numéricos positivos (ej. '200')."
  }
}
