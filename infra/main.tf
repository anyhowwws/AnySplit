terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "anysplit"
      ManagedBy = "terraform"
    }
  }
}

locals {
  name = "anysplit"

  # Where the esbuild output lands. `cd backend && npm run build` before apply.
  api_bundle_dir    = "${path.module}/../backend/dist/api"
  parser_bundle_dir = "${path.module}/../backend/dist/parser"
}

# Secrets are created out-of-band with `aws ssm put-parameter --type SecureString`
# and read here. Anything in a `resource` block lands in state in PLAINTEXT, so
# these must stay `data` sources.
data "aws_ssm_parameter" "bot_token" {
  name = "/${local.name}/bot-token"
}

data "aws_ssm_parameter" "anthropic_key" {
  name = "/${local.name}/anthropic-key"
}

data "aws_ssm_parameter" "webhook_secret" {
  name = "/${local.name}/webhook-secret"
}
