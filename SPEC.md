# AnySplit — v1 Build Spec

A Telegram bot + Mini App that parses a restaurant receipt photo, lets one person
assign items to named friends, and produces per-person shareable breakdowns.

Singapore context: GST + service charge are derived from the receipt, not hardcoded.

---

## 1. Scope

### In scope for v1

- Admin DMs a receipt photo to the bot (private chat only)
- Vision model parses it into structured line items
- Mini App: review/correct parse, enter names, assign items, see live totals
- Backend computes per-person totals including proportional tax
- Bot DMs the admin one forwardable message per person, each carrying a deep link
- Recipient taps the link, starts the bot, sees their own breakdown
- All bill data auto-purges after 7 days

### Explicitly out of scope

| Not building | Why |
|---|---|
| Group chats | Not everyone shares a group |
| Simultaneous claiming | Admin-only assignment is simpler |
| Voice assignment | Best feature, but v2 |
| Receipt image storage | Never persisted — privacy + cost |
| User accounts / roster | Deep link carries identity |
| Payment history / analytics | Contradicts the 7-day TTL |
| PayNow QR | v2, high value |
| Custom domain | CloudFront + API Gateway give valid HTTPS for free |

### Core invariants

1. **All money is integer cents.** No floats anywhere — not in the DB, not in the
   API, not in the model output. Format to dollars only at render time.
2. **The grossing factor is derived, never hardcoded.**
   `factor = total / subtotal`, applied to each person's item sum. This handles
   service-charge-then-GST stacking, GST-only venues, hawker receipts with
   neither, and flat discounts, with zero branching.
3. **Quantities are expanded into units.** `2x Beer $12.00` is stored as two rows
   of `$6.00`. Splitting one of two beers needs no fraction UI.
4. **Cents are reconciled.** After rounding each person to 2dp, compare the sum to
   the actual total and add the 1-2 cent delta to the largest share.
5. **A model proposes, the admin confirms.** Nothing leaves the app without a
   human having seen it.

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (Node 22) | Shared types between Lambda and Mini App |
| Bot framework | grammY | `webhookCallback(bot, "aws-lambda-async")` |
| API routing | Hono | Lightweight, good Lambda adapter |
| Mini App | React + Vite + Tailwind | Static build, no SSR |
| Telegram SDK | `@telegram-apps/sdk-react` or raw `window.Telegram.WebApp` | Raw is fine, fewer deps |
| Vision parsing | Claude Sonnet 5 | Tool use for schema-enforced JSON. Haiku 4.5 measured too low in Phase 1 — see §8 |
| Image preprocessing | jimp | Pure JS, so the Lambda bundle stays a single file with no native binary |
| Bundling | esbuild | Fast, single-file Lambda output |
| IaC | Terraform | State in S3 + DynamoDB lock |

Check current model options and pricing at https://docs.claude.com/en/api/overview
before finalising the model choice.

---

## 3. Data model (DynamoDB)

One table, one item per bill. No sort key, no GSI. Every read is a single
`GetItem`.

```
Table: anysplit-bills
  PK (S)        billId              12-char base64url, e.g. "aK9x2mQp7Lz4"
  adminId (N)   Telegram user_id of the payer
  merchant (S)  "Ah Huat's Kitchen"
  subtotal (N)  14850               cents
  total (N)     17805               cents
  factor (N)    1.1990              total / subtotal
  status (S)    "parsing" | "review" | "final" | "error"
  units (L)     [{ id, name, displayName, cents, shared }]
  shares (L)    [{ idx, name, unitIds, cents }]   populated on finalise
  ttl (N)       1753900000          Unix epoch SECONDS
  serviceCharge (N)  1485           cents, as printed — informational only
  gst (N)            1470           cents, as printed — informational only
  note (S)      warning or error text surfaced in the UI
```

`subtotal` is the sum of `units`, **not** the receipt's printed subtotal. `factor`
must be relative to what actually gets divided up, or the shares won't add to the
total. When the two disagree, the parse still lands but `note` says so and the
admin reconciles it in the Review screen.

`serviceCharge` and `gst` are stored for display only — no calculation reads
them. They exist so the summary message can show the receipt's own breakdown.

One extra item shape shares the table: `billId = "upd#<update_id>"` with a
1-hour `ttl`, written conditionally to dedupe Telegram's webhook retries. A
second table for that would be pure ceremony.

Billing mode: `PAY_PER_REQUEST`. At this volume it is effectively free.

### TTL

```hcl
ttl {
  attribute_name = "ttl"
  enabled        = true
}
```

Set `ttl = now + (7 * 86400)` on write.

**Important:** DynamoDB TTL deletion is not immediate — AWS typically deletes
within 48 hours of expiry. Always re-check `ttl` on read and treat expired items
as absent. Two lines of code, and it makes the retention promise honest.

---

## 4. Telegram integration details

### Deep link format

```
https://t.me/<bot_username>?start=<billId>-<shareIdx>
```

Payload limit: **64 characters**, charset `A-Z a-z 0-9 _ -`.
`aK9x2mQp7Lz4-3` is 14 characters. Ample headroom.

### Webhook security

When calling `setWebhook`, pass a `secret_token`. Telegram then sends it as the
`X-Telegram-Bot-Api-Secret-Token` header on every request. **Reject any request
without a matching header.** Without this, anyone who discovers the API Gateway
URL can inject fake updates.

### initData validation (Mini App → backend)

On every authenticated request:

1. `secret = HMAC_SHA256(key: "WebAppData", msg: bot_token)`
2. Build `data_check_string`: all fields except `hash`, sorted by key,
   joined as `k=v` with `\n`
3. `HMAC_SHA256(key: secret, msg: data_check_string)` must equal `hash`
4. Reject if `auth_date` is older than ~3 hours

Never trust a `user_id` from a request body. Only from verified `initData`.

### Photo retrieval

`message.photo` is an array of sizes — take the **last** element (largest).
Call `getFile`, then stream from
`https://api.telegram.org/file/bot<token>/<file_path>`
directly into the vision call. Never write it to disk or S3.

Also accept `message.document` for image mimetypes — long receipts get badly
compressed as photos, and sending as a file preserves small print.

### Idempotency

Telegram retries webhooks that don't get a fast 200. Dedupe on `update_id`
before processing, and always return 200 quickly (< 3s) even on internal failure.

---

## 5. Vision parsing

Use tool use with a forced tool choice so the model must return schema-valid JSON
rather than prose you have to unfence.

Tool input schema:

```json
{
  "merchant": "string",
  "items": [{
    "rawName": "string",
    "displayName": "string",
    "qty": "integer",
    "unitPriceCents": "integer",
    "isLikelyShared": "boolean"
  }],
  "subtotalCents": "integer",
  "serviceChargeCents": "integer",
  "gstCents": "integer",
  "totalCents": "integer"
}
```

Prompt notes:
- Ask for cents as integers explicitly. Models drift to floats otherwise.
- `displayName` expands receipt abbreviations (`TRFL FRS` → `Truffle Fries`).
- `isLikelyShared` flags rice, sides, appetisers — used to pre-select
  split-across-everyone in the UI.
- Handle Chinese/mixed-language item names; return the original in `rawName`.

**Validation gate:** after parsing, check
`sum(qty * unitPriceCents) == subtotalCents`.
On mismatch, set `status = "review"` and tell the admin the numbers don't
reconcile. Do not silently proceed.

---

## 6. Calculation

```ts
const factor = totalCents / subtotalCents;

const raw = shares.map(s => {
  const base = s.unitIds.reduce((sum, id) => sum + unitCents(id) / claimCount(id), 0);
  return base * factor;
});

const rounded = raw.map(v => Math.round(v));
const delta = totalCents - rounded.reduce((a, b) => a + b, 0);
const maxIdx = rounded.indexOf(Math.max(...rounded));
rounded[maxIdx] += delta;
```

`claimCount(id)` is how many people share that unit. Unassigned units should
block finalisation — surface an "unassigned: $X.XX" banner in the UI.

---

## 7. AWS architecture

```
Telegram ──> API Gateway (HTTP API) ──> Lambda: api
                                          │
                                          ├─> SQS ──> Lambda: parser ──> Claude API
                                          │                    │
                                          └────────────────────┴──> DynamoDB

Mini App: S3 ──> CloudFront ──> (fetch) ──> API Gateway
```

Two Lambdas:
- **api** — handles the Telegram webhook *and* the Mini App REST routes.
  Must ack Telegram in under 3s, so it only enqueues.
- **parser** — SQS-triggered, 60s timeout, does the vision call and DB write,
  then edits the original Telegram message.

### Terraform resource list

```
aws_dynamodb_table              bills (PAY_PER_REQUEST, TTL enabled)
aws_sqs_queue                   parse-queue
aws_sqs_queue                   parse-dlq
aws_lambda_function             api
aws_lambda_function             parser
aws_lambda_event_source_mapping sqs -> parser
aws_apigatewayv2_api            http api
aws_apigatewayv2_integration    -> api lambda
aws_apigatewayv2_route          ANY /{proxy+}
aws_apigatewayv2_stage          $default (auto_deploy)
aws_lambda_permission           apigw invoke
aws_s3_bucket                   miniapp (private)
aws_cloudfront_origin_access_control
aws_cloudfront_distribution     miniapp
aws_s3_bucket_policy            allow OAC only
aws_iam_role / policies         per-lambda least privilege
aws_cloudwatch_log_group        x2, retention_in_days = 14
aws_cloudwatch_metric_alarm     DLQ depth > 0
data.aws_ssm_parameter          bot token, anthropic key, webhook secret
aws_sns_topic / subscription    alarm delivery
```

### Gotchas

- **Do not put secrets in Terraform.** Create the SSM SecureString parameters via
  CLI, then read them with a `data` source. Anything in a `resource` block lands
  in state in plaintext.
  **This is not sufficient on its own.** A `data` source's *value* is also stored
  in state, so passing `data.aws_ssm_parameter.bot_token.value` into a Lambda
  `environment` block leaks it just the same, one step removed. Terraform
  therefore passes the parameter **path**, and the Lambda resolves the value from
  SSM at runtime, cached per container (`backend/src/lib/secrets.ts`). That also
  keeps secrets out of the Lambda's own configuration, which is readable by
  anyone holding `lambda:GetFunctionConfiguration`.
- **No custom domain needed.** CloudFront's `*.cloudfront.net` and API Gateway's
  `*.execute-api.*.amazonaws.com` both have valid HTTPS certs, which is all
  Telegram requires. This removes ACM, Route 53, and the us-east-1 provider alias
  entirely from v1.
- **CloudFront needs SPA routing:** custom error response mapping 403 and 404 →
  `/index.html` with status 200.
- **Use OAC, not the legacy OAI.**
- Lambda log retention defaults to *never expire* — set it explicitly or you pay
  forever.

Expected cost: **$1–3/month**, mostly within free tier, plus a few dollars of
vision API calls.

---

## 8. Phases

### Phase 0 — Telegram setup (no code)

1. DM `@BotFather` → `/newbot` → choose name and username → **save the token**
2. `/setprivacy` → **Disable** (harmless now, needed if you ever add groups)
3. `/setdescription` and `/setabouttext`
4. `/setcommands`:
   ```
   start - Show your bill share
   help - How this works
   ```
5. Leave Mini App registration until Phase 3 — you need the CloudFront URL first.

### Phase 1 — Prove the parse (no AWS)

Local script only. This is the highest-risk item; validate it before building
anything around it.

1. `cd backend && npm install` (the Anthropic SDK is already a dependency; no
   `dotenv` needed — Node 22's `--env-file` reads `.env` natively)
2. Write `scripts/parse.ts` — read a local JPEG, base64, call with the tool schema
   ```bash
   node --env-file=../.env --experimental-strip-types ../scripts/parse.ts ../receipts/*.jpg
   ```
3. Collect **10+ real receipts**: a restaurant with GST + service, a hawker stall
   with neither, one with Chinese item names, one crumpled, one very long
4. Iterate the prompt until the subtotal check passes consistently
5. Record accuracy. If Haiku struggles, try Sonnet and compare cost vs. quality

**Exit criteria:** subtotal reconciles on 9/10 receipts without manual fixes.

#### Results (first run, 9 real Singapore receipts)

|                   | raw photo | cropped |
|-------------------|-----------|---------|
| `claude-haiku-4-5`| 3/9       | 5/9     |
| `claude-sonnet-5` | 6/9       | **7–8/9** |

Two independent levers, and they compound — neither alone clears the bar:

- **Cropping to the receipt is the bigger surprise.** Claude downsizes every
  image to a fixed maximum long edge, so a photo where the receipt fills 40–70%
  of the frame spends most of its pixel budget on the table. `lib/preprocess.ts`
  crops before the call. It is also *cheaper*, since the image is smaller.
- **Rotation is a red herring.** Correcting EXIF orientation alone changed
  nothing (3/9 → 3/9), so there is deliberately no deskew logic. Jimp applies
  the EXIF tag on read and that is sufficient.
- **The model upgrade is real but insufficient** — Sonnet on raw photos is 6/9.

Two caveats worth carrying forward:

- `temperature` cannot be used to make this reproducible: it is **deprecated on
  Sonnet 5 and later** and returns a 400. Expect mild run-to-run variance on
  marginal receipts (the 7-vs-8 above is one borderline receipt flipping).
- **n=9 is a small sample.** 7–8/9 is not meaningfully distinguishable from the
  9/10 target. Re-measure once 20+ receipts are collected.

The one consistent failure is a receipt whose thermal print has faded to where
`$10.00` and `$70.00` are genuinely ambiguous to a careful human. No model or
preprocessing fixes that — it is precisely what invariant 5 and the Review
screen exist for.

### Phase 2 — Terraform foundation

1. `aws configure` with a dedicated IAM user (not root)
2. Create the state backend manually:
   ```bash
   aws s3api create-bucket --bucket anysplit-tfstate-<random> --region ap-southeast-1 \
     --create-bucket-configuration LocationConstraint=ap-southeast-1
   aws s3api put-bucket-versioning --bucket anysplit-tfstate-<random> \
     --versioning-configuration Status=Enabled
   ```
3. Store secrets outside Terraform:
   ```bash
   aws ssm put-parameter --name /anysplit/bot-token --type SecureString --value "123:ABC..."
   aws ssm put-parameter --name /anysplit/anthropic-key --type SecureString --value "sk-ant-..."
   ```
4. Write `infra/` — `main.tf`, `dynamodb.tf`, `iam.tf`, `variables.tf`, `outputs.tf`
5. Start with DynamoDB + IAM only. `terraform init`, `plan`, `apply`
6. Verify the table exists and TTL is enabled

**Exit criteria:** `terraform apply` is clean and idempotent on second run.

### Phase 3 — Bot backend

1. Add `lambda.tf`, `sqs.tf`, `apigw.tf`
2. Build pipeline: esbuild → `dist/api.js`, `dist/parser.js` → zip →
   `archive_file` data source
3. Implement `api` handler:
   - Verify `X-Telegram-Bot-Api-Secret-Token`
   - Dedupe on `update_id`
   - On photo: create bill in `parsing` status, enqueue, reply "Reading receipt…"
   - Return 200 immediately
4. Implement `parser` handler: `getFile` → stream → vision call → write units →
   `editMessageText` with the parsed summary
5. Register the webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<api-id>.execute-api.ap-southeast-1.amazonaws.com/webhook" \
     -d "secret_token=<random-32-char-string>"
   ```
6. Verify with `getWebhookInfo` — check `pending_update_count` and
   `last_error_message`

**Exit criteria:** send a photo in DM, get a correctly parsed itemised list back
as text. No Mini App yet.

### Phase 4 — Mini App

1. `npm create vite@latest miniapp -- --template react-ts`, add Tailwind
2. Load `https://telegram.org/js/telegram-web-app.js` in `index.html`
3. Call `WebApp.ready()` and `WebApp.expand()` on mount
4. Theme from Telegram's CSS variables (`--tg-theme-bg-color` etc.) so it doesn't
   look foreign
5. Screens:
   - **Review** — editable item names and prices, subtotal mismatch warning
   - **People** — add names (free text), 2–12
   - **Assign** — item list, chip row per item, tap to toggle, sticky
     "unassigned: $X.XX" bar
   - **Summary** — per-person totals, "Send" button
6. Every API call sends `initData` in an `Authorization` header; backend validates
7. Add `s3.tf` + `cloudfront.tf`, deploy the build
8. BotFather → `/newapp` → attach the CloudFront URL

**Exit criteria:** full assignment round-trip works on a real phone.

### Phase 5 — Share flow

1. `POST /bills/:id/finalise` — compute shares, reconcile cents, persist,
   set `status = "final"`
2. Mini App calls it, then `WebApp.close()`
3. Bot DMs the admin one message per person:
   ```
   Marcus — $34.20
   Ribeye, 2 beers

   Tap for the breakdown:
   https://t.me/AnySplit?start=aK9x2mQp7Lz4-1
   ```
4. Admin forwards each natively
5. Implement `/start <payload>`: split on `-`, `GetItem`, check TTL, render that
   person's breakdown. Handle expired and malformed payloads gracefully.

**Exit criteria:** forward a link to someone who has never used the bot; they see
their share correctly.

### Phase 6 — Harden

1. DLQ alarm → SNS → your email
2. Structured JSON logging with `billId` on every line
3. Friendly errors for: unreadable photo, non-receipt image, expired bill
4. GitHub Actions: build → `terraform plan` on PR → `apply` on merge to main
5. Verify a TTL item actually disappears (wait, or set a short TTL to test)

---

## 9. Repo layout

```
anysplit/
├── SPEC.md  README.md  .env.example
├── .github/workflows/ci.yml
├── infra/
│   ├── main.tf  backend.tf  variables.tf  outputs.tf  README.md
│   ├── dynamodb.tf  sqs.tf  lambda.tf  apigw.tf
│   ├── s3.tf  cloudfront.tf  iam.tf  monitoring.tf
├── backend/
│   ├── src/
│   │   ├── handlers/{api,parser}.ts
│   │   ├── lib/{bot,telegram,vision,preprocess,db,initdata,queue,secrets,config,format,ids,log}.ts
│   │   └── lib/{calc,money}.ts        # thin re-exports of shared/
│   └── package.json  tsconfig.json  build.mjs
├── miniapp/
│   ├── src/
│   │   ├── screens/{Review,People,Assign,Summary}.tsx
│   │   ├── components/Chrome.tsx
│   │   ├── lib/{api,telegram,limits}.ts
│   │   └── App.tsx  main.tsx  index.css
│   └── package.json  tsconfig.json  vite.config.ts  index.html
├── shared/{types,calc,money}.ts
└── scripts/parse.ts
```

`calc.ts` and `money.ts` live in `shared/` rather than `backend/` because the
Mini App needs them too: the Summary screen previews per-person totals with the
same `computeShares` the server runs on finalise, so the payer approves exactly
what gets sent. `backend/src/lib/{calc,money}.ts` are one-line re-exports, which
keeps backend imports local-looking without forking the arithmetic.

---

## 10. Test receipts to collect before Phase 1

- Restaurant with 10% service + 9% GST
- Hawker / kopitiam with no tax lines
- Receipt with Chinese or mixed-language item names
- One with a discount or promo line
- One very long (30+ items) to test photo compression
- One crumpled or badly lit
- One handwritten chit
