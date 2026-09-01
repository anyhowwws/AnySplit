# AnySplit

A Telegram bot that splits a restaurant bill from a photo of the receipt.

One person photographs the receipt, assigns each item to a name, and AnySplit
produces a per-person total with tax and service charge folded in proportionally.
The payer forwards one message per person, or pastes a single consolidated
message into a group chat. Each message carries the full breakdown inline — no
links to follow.

Built for Singapore, where a receipt might stack 10% service charge and then 9%
GST, or have neither — so both are read off the receipt rather than configured.

See [SPEC.md](SPEC.md) for the design and phased build plan.

## Status

**Live.** The bot is deployed and working end to end: photo in, per-person or
group messages out.

| Phase | State |
|---|---|
| 0 — Telegram setup | ✅ bot, commands, privacy policy |
| 1 — Prove the parse | ✅ **7–8/9** on real receipts (see [SPEC.md §8](SPEC.md)) |
| 2 — Terraform foundation | ✅ applied |
| 3–5 — Backend, Mini App, share flow | ✅ deployed and exercised |
| 6 — Harden | ✅ alarms, usage metrics, hashed log ids. CI still needs an `AWS_ROLE_ARN` repo variable before the workflow can run |

Also since the original spec: receipt cropping before the vision call, a second
validation gate on the summary arithmetic, an optional payee, group vs
per-person delivery, and `/test` fixtures that exercise the whole flow without
spending anything on a vision call.

## Prerequisites

- **Node 22+** (Node 26 in use here).
- Terraform ≥ 1.10 (1.15 in use), and AWS credentials for a dedicated IAM user.
  Note the `AWS_PROFILE=terraform` requirement — see [infra/README.md](infra/README.md).
- A bot token from [@BotFather](https://t.me/BotFather).
- An Anthropic API key.

## Layout

```
AnySplit/
├── shared/          types, money, and calc — imported by BOTH backend and miniapp
├── backend/         two Lambdas: `api` (webhook + REST) and `parser` (vision)
├── miniapp/         React + Vite + Tailwind, static, served from CloudFront
├── infra/           Terraform
└── scripts/parse.ts Phase 1 harness: prove the parse before building around it
```

`shared/calc.ts` is imported by the Mini App as well as the backend on purpose.
The Summary screen previews per-person totals using the *same* `computeShares`
the server runs on finalise, so what the payer approves is exactly what gets
sent. Two copies of that arithmetic would eventually disagree by a cent.

## The four invariants

Everything else follows from these.

1. **All money is integer cents.** No floats in the DB, the API, or the model
   output. Formatting to dollars happens only at render time.
2. **The grossing factor is derived, never hardcoded.** `factor = total / subtotal`,
   applied to each person's item sum. That one line covers
   service-charge-then-GST stacking, GST-only venues, hawker receipts with
   neither, and flat discounts, with no branching.
3. **Quantities are expanded into units.** `2x Beer $12.00` is stored as two rows
   of `$6.00`, so giving one beer to each of two people needs no fraction UI.
4. **Cents are reconciled.** After rounding each person to whole cents, the 1–2
   cent remainder goes to the largest share, so the shares sum to exactly what
   was paid.

And one rule about people: a model proposes, the admin confirms. Every field the
vision call produces is editable before anything is sent.

## Build and deploy

```bash
# 1. Prove the parse first — this is the highest-risk part of the whole system.
cd backend && npm install
cp ../.env.example ../.env   # add your ANTHROPIC_API_KEY
node --env-file=../.env --experimental-strip-types ../scripts/parse.ts ../receipts/*.jpg
# Exit criteria: the subtotal reconciles on 9 of 10 real receipts.

# 2. Infrastructure. See infra/README.md for state bootstrap and SSM secrets.
#    AWS_PROFILE=terraform is required — the provider can't read this machine's
#    `login_session` credentials. infra/README.md explains the profile.
npm run build
cd ../infra
cp backend.hcl.example backend.hcl   # then set your state bucket name
AWS_PROFILE=terraform terraform init -backend-config=backend.hcl
AWS_PROFILE=terraform terraform apply

# 3. Mini App, which needs the API URL from the Terraform outputs.
cd ../miniapp && npm install
VITE_API_BASE="$(terraform -chdir=../infra output -raw api_base_url)" npm run build
aws s3 sync dist/ "s3://$(terraform -chdir=../infra output -raw miniapp_bucket)/" --delete

# 4. Point Telegram at the webhook.
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=$(terraform -chdir=infra output -raw webhook_url)" \
  -d "secret_token=$WEBHOOK_SECRET"

# 5. BotFather -> /newapp -> attach the miniapp_url output.
```

Verify with `getWebhookInfo`; check `pending_update_count` and
`last_error_message`.

## Working from another machine

Everything needed to build and deploy is in the repo **except five things**, all
deliberately untracked because they hold secrets or identifiers that should not
be in a public repo. After cloning, recreate them:

| What | Where it comes from |
|---|---|
| `.env` | `cp .env.example .env`, then paste your Anthropic key. Only needed for `scripts/parse.ts` |
| `infra/backend.hcl` | `cp backend.hcl.example backend.hcl` — the Terraform state bucket, whose name embeds the AWS account id |
| `infra/terraform.tfvars` | `test_user_id = "<your Telegram user id>"` — gates the `/test` fixtures |
| AWS credentials | `aws login`, plus the `terraform` profile described in [infra/README.md](infra/README.md) |
| `node_modules/` | `npm install` in both `backend/` and `miniapp/` |

Nothing else is machine-specific. Terraform state lives in S3, so a fresh clone
picks up the existing infrastructure on `terraform init` rather than trying to
recreate it. The bot token, Anthropic key, and webhook secret are in SSM and are
never on disk at all.

```bash
git clone <your-repo-url> && cd AnySplit
cp .env.example .env                       # add ANTHROPIC_API_KEY
printf 'bucket = "anysplit-tfstate-%s"\n' \
  "$(aws sts get-caller-identity --query Account --output text)" > infra/backend.hcl
printf 'test_user_id = "%s"\n' "<telegram-id>" > infra/terraform.tfvars
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
| `image preprocessed` | `cropped` and `keptFraction`. `cropped:false` means the crop bailed and accuracy will be lower |
| `vision call complete` | `inputTokens` scales with image area — a jump usually means cropping stopped working, not longer receipts |
| `receipt parsed` | `reconciled:false` means items don't match the printed subtotal |

**Two deliberate omissions.** No message text, item names, or image bytes are
ever logged — a log line is storage, and AnySplit promises receipts aren't
stored. For commands only the verb is recorded, so `/start <billId>` logs as
`/start`. Separately, bot tokens are scrubbed from every line: HTTP clients quote
the URL they failed on, Telegram URLs embed the token, and a token in CloudWatch
would outlive any rotation.

## Security posture

- **Webhook authentication.** `setWebhook` registers a `secret_token`, which
  Telegram then sends as `X-Telegram-Bot-Api-Secret-Token`. Requests without a
  matching header are rejected — otherwise anyone who discovers the API Gateway
  URL can inject fake updates.
- **initData verification.** Every Mini App request carries Telegram's signed
  `initData`; the backend recomputes the HMAC and rejects payloads older than
  three hours. A `user_id` from a request body is never trusted.
- **Admin-only mutation.** Only the payer who sent the photo can read or modify a
  bill. Recipients see their share through the bot, not the API.
- **Unguessable bill ids.** 72 bits of entropy, because the deep link is the only
  access control on a share.
- **Secrets never enter Terraform state.** Terraform passes SSM parameter
  *paths*; Lambda resolves the values at runtime.

## Privacy

- Receipt photos are streamed from Telegram straight into the vision call. They
  are never written to disk or S3.
- Bill data auto-purges 24 hours after the last action on it — sending refreshes
  the clock rather than ending it, so a split can still be corrected or re-sent.
  Because DynamoDB TTL deletion can lag by up to 48 hours, `ttl` is re-checked on
  every read and expired bills are treated as absent, so the promise holds
  regardless of when AWS gets round to the delete.
- No accounts, no roster, no payment history. There is nothing to mine.

## Cost

$1–3/month, mostly inside the free tier, plus vision API calls (a few dollars at
personal volume).
