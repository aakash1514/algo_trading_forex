# Exact pins: Terraform and the AWS provider change only by a deliberate edit here and a new
# .terraform.lock.hcl (terraform providers lock, all four platforms; docs/DEPLOY.md section 7).
terraform {
  required_version = "= 1.16.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.70.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "forexedge"
      ManagedBy = "terraform"
    }
  }
}
