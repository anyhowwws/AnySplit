# infra

Terraform for AnySplit. Region defaults to `ap-southeast-1`.

## One-time bootstrap (before the first `terraform init`)

Terraform cannot create its own state backend, so this runs first. Already done
for the live deployment; kept here for rebuilding in a fresh account.

```bash
BUCKET=anysplit-tfstate-$(aws sts get-caller-identity --query Account --output text)
aws s3api create-bucket --bucket "$BUCKET" --region ap-southeast-1 \
  --create-bucket-configuration LocationConstraint=ap-southeast-1
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
printf 'bucket = "%s"\n' "$BUCKET" > backend.hcl
```

Versioning is not optional: it is the only way back if a state file is corrupted
or a bad apply is rolled back.

That last line writes `backend.hcl`, which is **gitignored**. The bucket name
embeds the AWS account id, so it is supplied to `terraform init` rather than
committed — see `backend.tf` and `backend.hcl.example`. Every `init` in this
directory therefore needs `-backend-config=backend.hcl`.

State locking uses S3 conditional writes (`use_lockfile = true`, Terraform ≥1.10),
so there is no DynamoDB lock table to create.

## Secrets

Secrets are **never** passed through Terraform. Create them once with the CLI;
Terraform only reads their *paths* and hands those to Lambda, which resolves the
values from SSM at runtime.

```bash
aws ssm put-parameter --name /anysplit/bot-token      --type SecureString --value "123456:ABC..."
aws ssm put-parameter --name /anysplit/anthropic-key  --type SecureString --value "sk-ant-..."
aws ssm put-parameter --name /anysplit/webhook-secret --type SecureString --value "$(openssl rand -hex 16)"
```

Why the indirection: reading a SecureString through a `data` source and passing
the value into a Lambda `environment` block writes the plaintext into
`terraform.tfstate`. That is the same leak as putting it in a `resource`, one
step removed.

## Credentials

This machine authenticates the AWS CLI with `login_session` (see `~/.aws/config`).
The Terraform AWS provider uses the Go SDK, which **cannot resolve
`login_session`** — running Terraform against the `default` profile fails with
`No valid credential sources found`, even though `aws sts get-caller-identity`
works fine.

The fix is a `terraform` profile in `~/.aws/config` that shells out to the CLI:

```ini
[profile terraform]
region = ap-southeast-1
credential_process = aws configure export-credentials --profile default --format process
```

So every Terraform command here needs `AWS_PROFILE=terraform`.

`--profile default` in that line is load-bearing — pointing it at itself would
recurse. And `credential_process` is preferred over
`eval "$(aws configure export-credentials --format env)"` because the login
session is short-lived (~15 min): static env vars freeze at export time and can
expire midway through a CloudFront apply, whereas Terraform can re-invoke a
credential process to refresh.

CI is unaffected — GitHub Actions authenticates via OIDC role assumption.

## Apply order

The Lambda zips are built artefacts, so the backend must be built first.

```bash
cd ../backend && npm install && npm run build && cd ../infra
AWS_PROFILE=terraform terraform init -backend-config=backend.hcl
AWS_PROFILE=terraform terraform plan
AWS_PROFILE=terraform terraform apply
```

Then deploy the Mini App, which needs the API URL from the outputs:

```bash
cd ../miniapp
VITE_API_BASE="$(terraform -chdir=../infra output -raw api_base_url)" npm run build
aws s3 sync dist/ "s3://$(terraform -chdir=../infra output -raw miniapp_bucket)/" --delete
aws cloudfront create-invalidation \
  --distribution-id "$(terraform -chdir=../infra output -raw cloudfront_distribution_id)" \
  --paths '/index.html'
```

## Resource inventory

| File | Contains |
|---|---|
| `main.tf` | provider, locals, SSM `data` sources |
| `backend.tf` | S3 remote state, bucket supplied via `backend.hcl` |
| `dynamodb.tf` | bills table, TTL enabled |
| `sqs.tf` | parse queue, DLQ, event source mapping |
| `iam.tf` | one least-privilege role per Lambda |
| `lambda.tf` | both functions, log groups with explicit retention |
| `apigw.tf` | HTTP API, `ANY /{proxy+}`, `$default` stage, CORS |
| `s3.tf` | private Mini App bucket, OAC-only policy |
| `cloudfront.tf` | distribution with SPA error mapping |
| `monitoring.tf` | SNS topic, DLQ-depth and api-error alarms |
| `outputs.tf` | URLs and names the deploy steps need |

## Notes

- No custom domain. CloudFront's `*.cloudfront.net` and API Gateway's
  `*.execute-api.*.amazonaws.com` both carry valid HTTPS certificates, which is
  all Telegram requires — so ACM, Route 53, and a `us-east-1` provider alias are
  all absent by design.
- Log retention is set explicitly. Lambda's implicitly-created log groups never
  expire, and you pay for that indefinitely.
- `terraform apply` should be clean and idempotent on a second run. If it isn't,
  the usual cause is a stale `backend/dist` — rebuild before applying.
