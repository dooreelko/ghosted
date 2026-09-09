terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Partial backend config: the state bucket's name embeds the account ID,
  # which must not live in a tracked file (see CLAUDE.md, Sensitive data).
  # The bucket/key/region are supplied from the gitignored `backend.hcl`
  # in this directory:
  #     tofu init -backend-config=backend.hcl
  # The bucket itself is created and owned OUTSIDE this config (it can't
  # bootstrap the state it stores); its name is recorded in
  # `.local-secrets.md`.
  backend "s3" {}
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      app = "ghost-phase2"
    }
  }
}
