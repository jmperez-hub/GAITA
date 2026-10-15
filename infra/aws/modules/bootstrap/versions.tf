terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # No backend block — local state for bootstrap.
  # After applying, migrate the state with: tofu state push terraform.tfstate
}
