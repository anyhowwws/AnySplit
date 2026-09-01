# Remote state. The bucket and lock table must exist BEFORE the first
# `terraform init` — Terraform cannot bootstrap its own backend. See
# infra/README.md for the two `aws s3api` commands that create them.
#
# `bucket` is deliberately absent. S3 bucket names are globally unique and this
# one is derived from the AWS account id, so hardcoding it here would publish
# that id in a public repo. It is supplied at init time instead:
#
#   terraform init -backend-config=backend.hcl
#
# See backend.hcl.example. This is Terraform's "partial configuration" — any
# backend argument may be omitted here and provided at init.
#
# `use_lockfile` replaces the old DynamoDB lock table (deprecated since
# Terraform 1.10); S3 conditional writes provide the lock now.
terraform {
  backend "s3" {
    key          = "anysplit/terraform.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
}
