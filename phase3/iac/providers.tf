terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Partial backend config, as in Phase 2: the state bucket's name embeds the
  # account ID, which must not live in a tracked file (see CLAUDE.md, Sensitive
  # data). Bucket, key and region come from the gitignored `backend.hcl` in
  # this directory:
  #     tofu init -backend-config=backend.hcl
  # The state bucket is owned outside this config; its name is recorded in
  # `.local-secrets.md`. Phase 3 uses its own state key.
  backend "s3" {}
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      app = "ghost-phase3"
    }
  }
}
