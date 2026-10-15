# eks/variables.tf

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

variable "vpc_id" {
  type        = string
  description = "ID de la VPC donde se desplegará el clúster EKS."
  validation {
    condition     = can(regex("^vpc-[0-9a-f]+$", var.vpc_id))
    error_message = "vpc_id debe tener el formato 'vpc-<hex>'."
  }
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Lista de IDs de subnets privadas donde se colocarán los nodos y el plano de control."
  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Se requieren al menos 2 subnets privadas para alta disponibilidad."
  }
}

variable "kubernetes_version" {
  type        = string
  description = "Versión de Kubernetes para el clúster EKS (p. ej. '1.31')."
  default     = "1.31"
  validation {
    condition     = can(regex("^1\\.\\d+$", var.kubernetes_version))
    error_message = "kubernetes_version debe tener el formato '1.XX'."
  }
}

variable "instance_types" {
  type        = list(string)
  description = "Tipos de instancia EC2 para los nodos del grupo administrado."
  default     = ["t3.medium"]
}

variable "node_min" {
  type        = number
  description = "Número mínimo de nodos en el grupo administrado."
  default     = 2
  validation {
    condition     = var.node_min >= 1
    error_message = "node_min debe ser al menos 1."
  }
}

variable "node_max" {
  type        = number
  description = "Número máximo de nodos en el grupo administrado."
  default     = 4
  validation {
    condition     = var.node_max >= 2
    error_message = "node_max debe ser al menos 2."
  }
}

variable "node_desired" {
  type        = number
  description = "Número deseado de nodos al momento del aprovisionamiento."
  default     = 2
}

variable "node_disk_gb" {
  type        = number
  description = "Tamaño del disco raíz (gp3) de cada nodo en GiB."
  default     = 50
  validation {
    condition     = var.node_disk_gb >= 20
    error_message = "node_disk_gb debe ser al menos 20 GiB."
  }
}

variable "kms_key_arn_plataforma" {
  type        = string
  description = "ARN de la llave KMS usada para cifrar los secrets de EKS y los volúmenes EBS de los nodos."
  validation {
    condition     = can(regex("^arn:aws:kms:", var.kms_key_arn_plataforma))
    error_message = "kms_key_arn_plataforma debe ser un ARN de KMS válido."
  }
}
