# AnySplit

A Telegram bot that splits a restaurant bill from a photo of the receipt.

One person photographs the receipt and assigns each item to a name in a Telegram
Mini App. AnySplit produces a per-person total with service charge and GST folded
in proportionally, and sends it back either as one forwardable message per person
or as a single consolidated message to paste into a group chat. Each message
carries the full breakdown inline — no links to follow.

Built for Singapore, where a receipt might stack 10% service charge and then 9%
GST, or have neither — so both are read off the receipt rather than configured.

**Live.** Deployed and working end to end: photo in, per-person or group
messages out.

This README is the operational half: how to run, deploy, and debug it.
**[DESIGN.md](DESIGN.md)** is the other half — architecture, application flow,
the invariants the arithmetic rests on, privacy and security posture, and the
reasoning behind each decision. [infra/README.md](infra/README.md) covers the
Terraform specifics: bootstrap, credentials, and the CI role.

## Layout

```
AnySplit/
├── shared/          types, money, calc, payee — imported by BOTH backend and miniapp
├── backend/         three Lambdas: `api` (webhook + REST), `parser` (vision), `report` (daily digest)
├── miniapp/         React + Vite + Tailwind, static, served from CloudFront
├── infra/           Terraform
└── scripts/parse.ts offline harness for measuring parse accuracy
```

## Prerequisites

- **Node 22+** (CI builds on 22).
- Terraform **≥ 1.10** (CI pins 1.10.5), and AWS credentials for a dedicated IAM
  user. Note the `AWS_PROFILE=terraform` requirement — see
  [infra/README.md](infra/README.md#credentials) for why the default profile does
  not work.
- A bot token from [@BotFather](https://t.me/BotFather).
- An Anthropic API key **only for `scripts/parse.ts`**. The deployed bot has
  none: the parser authenticates by workload identity federation, exchanging an
  AWS-signed assertion of its own IAM role for a short-lived token. See
  [DESIGN.md § Security posture](DESIGN.md#security-posture).

## Deploying

**`main` deploys itself.** A push there runs
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), which typechecks both
packages, builds the Lambda bundles, applies Terraform, rebuilds the Mini App
against the live API URL, syncs it to S3, and invalidates `index.html`. A pull
request gets its `terraform plan` posted as a comment and applies nothing.

There are no AWS keys in GitHub. CI assumes an IAM role through GitHub's OIDC
provider, defined in [`infra/github_oidc.tf`](infra/github_oidc.tf) and scoped to
two exact subjects — `main` and `pull_request`.

### Repository secrets

Everything CI needs, all of it as **secrets** rather than variables. Most are not
truly confidential, but this repository is public, Actions echoes a step's inputs
into a world-readable log, a variable prints verbatim, and several of these values
embed the AWS account id or a personal Telegram id.

The three `TF_VAR_*` federation values and the two email addresses matter for a
second reason: they live in the gitignored `infra/terraform.tfvars` locally, and
without them CI plans against the variables' empty defaults and *removes* what a
local apply configured.

| Secret | Value |
|---|---|
| `AWS_ROLE_ARN` | `terraform -chdir=infra output -raw github_actions_role_arn` |
| `TF_STATE_BUCKET` | the bucket in `infra/backend.hcl` |
| `ALARM_EMAIL` | where CloudWatch alarms are delivered |
| `REPORT_EMAIL` | where the daily usage digest is delivered |
| `TEST_USER_ID` | Telegram user id allowed to run `/test`. Empty disables the command |
| `ANTHROPIC_FEDERATION_RULE_ID` | `fdrl_…`, from Anthropic Console → Settings → Workload identity |
| `ANTHROPIC_ORGANIZATION_ID` | Anthropic organization UUID owning that rule |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | `svac_…`, the identity the minted token acts as |

`ANTHROPIC_WORKSPACE_ID` is wired through Terraform as well, but is only needed
when the federation rule spans more than one non-default workspace.

### One-time setup

CI cannot bootstrap itself — the role it assumes is created by the very Terraform
it runs — so a new deployment starts from a terminal.

```bash
# 1. Prove the parse first. It is the highest-risk part of the whole system,
#    and everything downstream assumes it works.
cd backend && npm install
cp ../.env.example ../.env   # add your ANTHROPIC_API_KEY
node --env-file=../.env --experimental-strip-types ../scripts/parse.ts ../receipts/*.jpeg
# Looking for: the subtotal reconciles on ~9 of 10 real receipts.

# 2. State bucket and SSM secrets — see infra/README.md for both.

# 3. First apply, which creates the CI role among everything else.
#    AWS_PROFILE=terraform is required: the provider can't read this machine's
#    `login_session` credentials. infra/README.md explains why.
npm run build
cd ../infra
cp backend.hcl.example backend.hcl   # then set your state bucket name
cp terraform.tfvars.example terraform.tfvars   # then fill in the values
AWS_PROFILE=terraform terraform init -backend-config=backend.hcl
AWS_PROFILE=terraform terraform apply

# 4. Hand the role and bucket to GitHub, after which pushes deploy themselves.
gh secret set AWS_ROLE_ARN --body "$(AWS_PROFILE=terraform terraform output -raw github_actions_role_arn)"
gh secret set TF_STATE_BUCKET --body "$(grep -o '"[^"]*"' backend.hcl | tr -d '"')"
#    ...and the six remaining secrets from the table above.

# 5. Point Telegram at the webhook.
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=$(AWS_PROFILE=terraform terraform output -raw webhook_url)" \
  -d "secret_token=$WEBHOOK_SECRET"

# 6. BotFather -> /newapp -> attach the miniapp_url output.
```

Verify with `getWebhookInfo`; check `pending_update_count` and
`last_error_message`.

If you fork this, the CI role's trust policy names *your* repository by its
numeric ids, so set `github_repo`, `github_owner_id` and `github_repo_id` in
`terraform.tfvars` before that first apply — see
[infra/github_oidc.tf](infra/github_oidc.tf) for why ids rather than names.

### Deploying by hand

Still supported, and still the only option for the two things CI deliberately
cannot do: anything needing `dynamodb:DeleteTable` (the CI role does not have it —
dropping the bills table should take a human at a terminal), and recovery when the
pipeline itself is broken.

```bash
cd backend && npm run build
AWS_PROFILE=terraform terraform -chdir=../infra apply

cd ../miniapp
VITE_API_BASE="$(AWS_PROFILE=terraform terraform -chdir=../infra output -raw api_base_url)" npm run build
aws s3 sync dist/ "s3://$(AWS_PROFILE=terraform terraform -chdir=../infra output -raw miniapp_bucket)/" --delete
aws cloudfront create-invalidation \
  --distribution-id "$(AWS_PROFILE=terraform terraform -chdir=../infra output -raw cloudfront_distribution_id)" \
  --paths '/index.html'
```

## Working from another machine

To *deploy* from another machine you need nothing beyond push access — that is
the point of the pipeline above. The list below is for working locally: running
the parse harness, or applying Terraform by hand.

Everything needed is in the repo **except five things**, all deliberately
untracked because they hold secrets or identifiers that should not be in a public
repo. After cloning, recreate them:

| What | Where it comes from |
|---|---|
| `.env` | `cp .env.example .env`, then paste your Anthropic key. Only needed for `scripts/parse.ts` |
| `infra/backend.hcl` | `cp backend.hcl.example backend.hcl` — the Terraform state bucket, whose name embeds the AWS account id |
| `infra/terraform.tfvars` | `cp terraform.tfvars.example terraform.tfvars` — the same values as the repository secrets above: alarm and report emails, the `/test` gate, and the three Anthropic federation ids |
| AWS credentials | `aws login`, plus the `terraform` profile described in [infra/README.md](infra/README.md#credentials) |
| `node_modules/` | `npm install` in both `backend/` and `miniapp/` |

Nothing else is machine-specific. Terraform state lives in S3, so a fresh clone
picks up the existing infrastructure on `terraform init` rather than trying to
recreate it. The bot token, webhook secret, and user-reference HMAC key are in
SSM and are never on disk at all.

```bash
git clone <your-repo-url> && cd AnySplit
cp .env.example .env                       # add ANTHROPIC_API_KEY
printf 'bucket = "anysplit-tfstate-%s"\n' \
  "$(aws sts get-caller-identity --query Account --output text)" > infra/backend.hcl
cp infra/terraform.tfvars.example infra/terraform.tfvars   # then fill it in
(cd backend && npm install) && (cd miniapp && npm install)
AWS_PROFILE=terraform terraform -chdir=infra init -backend-config=backend.hcl
```

## Debugging

Logs are single-line JSON. Every line carries the ambient context — `updateId`,
`billId`, `sqsMessageId` — attached automatically via `AsyncLocalStorage`, so one
filter reconstructs a whole bill across both Lambdas.

```bash
aws logs tail /aws/lambda/anysplit-api --follow --since 15m
```

Trace one bill end to end, across both functions:

```bash
aws logs tail /aws/lambda/anysplit-api /aws/lambda/anysplit-parser --since 1h --filter-pattern '"aK9x2mQp7Lz4"'
```

The lines worth knowing:

| Message | Means |
|---|---|
| `update received` | webhook arrived; `kind`, `chatType`, `coldStart` |
| `duplicate update dropped` | Telegram redelivered. **Without a matching `update handled`, the first attempt is failing and the retry is being suppressed on top of it** — that combination is what a dead bot looks like |
| `update handled but over telegram ack budget` | slower than ~2.5s; Telegram is about to redeliver |
| `telegram api ok` / `rejected` / `transport failed` | one line per Telegram call. `rejected` = Telegram said no; `transport failed` = the request never left the process |
| `rate limited` | a quota tier refused a receipt before any spend; `scope` says which |
| `image preprocessed` | `cropped` and `keptFraction`. `cropped:false` means the crop bailed and accuracy will be lower |
| `vision call complete` | `inputTokens` scales with image area — a jump usually means cropping stopped working, not longer receipts |
| `receipt parsed` | `reconciled:false` means items don't match the printed subtotal |

**Two deliberate omissions.** No message text, item names, or image bytes are ever
logged — a log line is storage, and AnySplit promises receipts aren't stored. For
commands only the verb is recorded, so `/start <billId>` logs as `/start`.
Separately, bot tokens are scrubbed from every line: HTTP clients quote the URL
they failed on, Telegram URLs embed the token, and a token in CloudWatch would
outlive any rotation.

Seven CloudWatch alarms and a daily usage digest cover what the logs alone would
not; [DESIGN.md § Observability](DESIGN.md#observability) explains what each one
is there to catch.

### `/test` — exercising the flow without paying for a vision call

`/test` runs seven canned receipts through the real `deriveBill()` logic — the
whole flow, including the validation failure paths, with only the model call
skipped. It is gated to the single Telegram id in `TEST_USER_ID`, and an empty
setting disables it, so an unconfigured deployment fails closed. Send `/test` with
no argument for the menu.

## Cost

$1–3/month of AWS, mostly inside the free tier, plus vision calls — roughly
$26–31 per thousand receipts at Sonnet 5 standard pricing.

## Licence

**All rights reserved.** This repository is public so the design and the code can
be read — see [DESIGN.md](DESIGN.md) — not so they can be reused. No licence to
use, run, copy, modify or distribute is granted; see [LICENSE](LICENSE). Ask by
opening an issue if you want to.
