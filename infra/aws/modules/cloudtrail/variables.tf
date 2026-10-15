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

variable "cuenta_respaldos" {
  description = "ID de la cuenta AWS de respaldos donde se almacenará el bucket de CloudTrail (p. ej. {ACCOUNT_ID_RESPALDOS})"
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.cuenta_respaldos))
    error_message = "cuenta_respaldos debe ser un ID de cuenta AWS de 12 dígitos."
  }
}

variable "cuenta_management" {
  description = "ID de la cuenta AWS de management desde donde se crea el trail organizacional (p. ej. {ACCOUNT_ID_MANAGEMENT})"
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.cuenta_management))
    error_message = "cuenta_management debe ser un ID de cuenta AWS de 12 dígitos."
  }
}

variable "region" {
  description = "Región AWS principal donde se despliega el trail"
  type        = string
  default     = "us-east-1"
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "region debe tener formato AWS válido, p. ej. us-east-1."
  }
}

variable "kms_key_arn_respaldos" {
  description = "ARN de la clave KMS en la cuenta de respaldos usada para cifrar los logs de CloudTrail (p. ej. arn:aws:kms:{REGION}:{ACCOUNT_ID_RESPALDOS}:key/{KEY_ID})"
  type        = string
  validation {
    condition     = can(regex("^arn:aws:kms:", var.kms_key_arn_respaldos))
    error_message = "kms_key_arn_respaldos debe ser un ARN de clave KMS válido."
  }
}
