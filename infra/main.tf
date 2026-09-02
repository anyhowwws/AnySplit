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

data "aws_caller_identity" "current" {}

locals {
  name = "anysplit"

  # Where the esbuild output lands. `cd backend && npm run build` before apply.
  api_bundle_dir    = "${path.module}/../backend/dist/api"
  parser_bundle_dir = "${path.module}/../backend/dist/parser"
}

# Secrets are created out-of-band with `aws ssm put-parameter --type SecureString`.
# Terraform is told their *paths* and nothing else; the values are resolved at
# runtime by secrets.ts.
#
# These are deliberately plain strings rather than `data "aws_ssm_parameter"`
# blocks. A data source would be the obvious way to get a name and an ARN, and
# it was how this started — but reading a SecureString through one fetches the
# decrypted value and writes it into terraform.tfstate whether or not anything
# uses it. Only `.name` and `.arn` were ever referenced here, so the data
# sources bought nothing and cost three secrets in state, in a bucket that is
# versioned, so in every historical state as well.
#
# Paths and ARNs are not secret — they appear in this repository — so building
# them by hand loses nothing except Terraform's check that the parameter exists,
# which surfaces as a clear runtime error on the first call instead.
locals {
  ssm = {
    bot_token      = "/${local.name}/bot-token"
    webhook_secret = "/${local.name}/webhook-secret"
    # Keyed independently of the bot token so that rotating the token does not
    # re-key every pseudonymous user reference. See backend/src/lib/userref.ts.
    userref_salt = "/${local.name}/userref-salt"
  }

  ssm_arn = {
    for key, path in local.ssm :
    key => "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${path}"
  }
}
