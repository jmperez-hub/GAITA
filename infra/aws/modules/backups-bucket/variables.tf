# backups-bucket/variables.tf

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
  description = "ID numérico de la cuenta AWS (12 dígitos). Se usa como sufijo del nombre del bucket para garantizar unicidad global."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.cuenta_id))
    error_message = "El cuenta_id debe ser un número de 12 dígitos."
  }
}

variable "kms_key_arn_respaldos" {
  type        = string
  description = "ARN de la llave KMS de respaldos para cifrar el contenido del bucket"
  validation {
    condition     = can(regex("^arn:aws:kms:.+:[0-9]{12}:key/.+$", var.kms_key_arn_respaldos))
    error_message = "El kms_key_arn_respaldos debe ser un ARN válido de llave KMS."
  }
}

variable "rol_backup_arn" {
  type        = string
  description = "ARN del rol IAM que tiene permiso para leer y escribir objetos en el bucket de respaldos"
  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/.+$", var.rol_backup_arn))
    error_message = "El rol_backup_arn debe ser un ARN válido de rol IAM."
  }
}
