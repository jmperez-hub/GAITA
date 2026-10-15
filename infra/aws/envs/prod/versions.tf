terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  backend "s3" {
    bucket       = "gaitas-tofu-estado-{CUENTA_PROD}"
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    kms_key_id   = "alias/gaitas-tofu-estado-prod"
    use_lockfile = true # Bloqueo nativo S3 — sin DynamoDB (OpenTofu >= 1.10)
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      proyecto         = "gaitas"
      entorno          = "prod"
      "nivel-servicio" = "critico"
      repositorio      = "github.com/jmperez-hub/GAITA"
    }
  }
}
