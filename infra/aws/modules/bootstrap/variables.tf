# bootstrap/variables.tf

variable "entorno" {
  type        = string
  description = "Nombre del entorno de despliegue (dev, staging, prod)."
  validation {
    condition     = contains(["dev", "staging", "prod"], var.entorno)
    error_message = "El valor de entorno debe ser 'dev', 'staging' o 'prod'."
  }
}

variable "nivel_servicio" {
  type        = string
  description = "Nivel de servicio del recurso (p. ej. 'critico', 'alto', 'medio', 'bajo')."
  validation {
    condition     = contains(["critico", "alto", "medio", "bajo"], var.nivel_servicio)
    error_message = "nivel_servicio debe ser 'critico', 'alto', 'medio' o 'bajo'."
  }
}

variable "dueno" {
  type        = string
  description = "Equipo o persona responsable del recurso (p. ej. 'plataforma@laoccidental.com')."
}

variable "cuenta_id" {
  type        = string
  description = "ID de la cuenta AWS (12 dígitos). Se usa como sufijo del nombre del bucket para garantizar unicidad global."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.cuenta_id))
    error_message = "cuenta_id debe ser exactamente 12 dígitos numéricos."
  }
}

variable "rol_ci_arn" {
  type        = string
  description = "ARN del rol IAM usado por el pipeline de CI/CD (OIDC, sin llaves de acceso de larga duración). Se le otorgan permisos de lectura/escritura sobre el bucket de estado."
  default     = "{VALOR_ROL_CI_ARN}"
  validation {
    condition     = can(regex("^arn:aws:iam::", var.rol_ci_arn)) || var.rol_ci_arn == "{VALOR_ROL_CI_ARN}"
    error_message = "rol_ci_arn debe ser un ARN de IAM válido (arn:aws:iam::...)."
  }
}
