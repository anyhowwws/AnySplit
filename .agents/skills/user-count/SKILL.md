---
name: user-count
description: Report how many unique people have used AnySplit, counted from DynamoDB since day 0. Use whenever the user asks about user count, unique users, how many people use the bot, signups, adoption, or usage numbers.
---

# User count

Answer from the table, never from a CloudWatch metric. `NewUsers` only sees
signups that happened after the metric filter was deployed, so it undercounts.

## Run

```bash
cd backend && AWS_PROFILE=terraform npm run users
```

The `usr#` rows it counts are the ground truth: one per person, no `ttl`,
written since the day the bot went up. `AWS_PROFILE=terraform` is required —
the default profile has no access (see `infra/README.md`).

## Report

Lead with **unique users**. Add receipts parsed and the active date range as
context. Keep it to a few lines unless asked for more.

Never print or look up the row keys — they are HMAC pseudonyms of Telegram
user ids, and the script projects them away on purpose.

## If it reports DRIFT

The `meta#users` counter has fallen out of step with the rows. The row count is
still the right answer to give; say so, and note that the **daily report email
is wrong** until it is fixed, since that email reads the counter.

Offer the repair rather than running it unprompted — it writes to the
production table:

```bash
cd backend && AWS_PROFILE=terraform npm run users -- --reconcile
```

## Background

`backend/src/lib/usercount.ts` explains why the total is stored rather than
derived, and why the report Lambda reads a counter instead of counting rows.
