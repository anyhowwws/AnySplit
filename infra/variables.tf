variable "region" {
  description = "AWS region. Singapore keeps latency low for the intended users."
  type        = string
  default     = "ap-southeast-1"
}

variable "vision_model" {
  description = <<-EOT
    Claude model used for receipt parsing. Phase 1 measured subtotal
    reconciliation over 9 real receipts: Haiku 4.5 managed 3/9 on raw phone
    photos and 5/9 cropped; Sonnet 5 managed 6/9 and 8/9. Hence Sonnet as the
    default. claude-opus-5 is a drop-in if accuracy still falls short.
  EOT
  type        = string
  default     = "claude-sonnet-5"
}

variable "ttl_days" {
  description = <<-EOT
    How long a bill survives after the last action on it. Sending refreshes the
    clock rather than ending it, so a split can still be corrected or re-sent —
    one day is comfortably longer than any meal, and short enough that receipts
    do not accumulate.

    DynamoDB's TTL sweep can lag by up to 48 hours, so `ttl` is re-checked on
    every read and expired bills are treated as absent. The promise holds
    regardless of when AWS gets round to the delete.
  EOT
  type        = number
  default     = 1
}

variable "test_user_id" {
  description = <<-EOT
    Telegram user ID permitted to use the /test fixture command. Empty disables
    the command entirely, so a deployment that forgets to set it fails closed
    rather than exposing fixtures to everyone.

    Set in terraform.tfvars, which is gitignored — it is a personal identifier
    and does not belong in version control.
  EOT
  type        = string
  default     = ""
}

variable "github_repo" {
  description = <<-EOT
    The `owner/name` allowed to assume the CI role via OIDC. This is the only
    thing separating that role from every other repository on GitHub, so it is
    matched exactly — see github_oidc.tf. Change it if you fork this.
  EOT
  type        = string
  default     = "anyhowwws/AnySplit"
}

variable "github_owner_id" {
  description = <<-EOT
    Numeric GitHub id of the owner in `github_repo`. Pairs with
    `github_repo_id` to build the immutable OIDC subject — see github_oidc.tf
    for why the names alone are not enough.

      gh api repos/<owner>/<name> --jq '{owner_id: .owner.id, repo_id: .id}'
  EOT
  type        = string
  default     = "101925287"
}

variable "github_repo_id" {
  description = "Numeric GitHub id of the repository. See `github_owner_id`."
  type        = string
  default     = "1353577566"
}

variable "alarm_email" {
  description = <<-EOT
    Address that receives every alarm. Leave empty to skip the subscription —
    but note that the alarms still exist and still fire, they simply publish to
    a topic with no subscribers, which is indistinguishable from nothing being
    wrong. Set this.

    AWS sends a confirmation link on first apply; the subscription delivers
    nothing until it is clicked.
  EOT
  type        = string
  default     = ""
}

# ------------------------------------------------- workload identity federation
#
# The parser authenticates to the Anthropic API with no API key: it mints an
# AWS-signed JWT asserting its own role ARN and exchanges it for a short-lived
# token. These four values name the Console resources that exchange targets.
#
# None is a secret — an attacker holding all four still cannot get a token
# without being able to assume the parser's IAM role — but they identify the
# account, and this repository is public, so they live in terraform.tfvars
# (gitignored) and reach CI as TF_VAR_ secrets, like every other identifier here.

variable "anthropic_federation_rule_id" {
  description = "Federation rule (fdrl_...) the token exchange targets. From Settings → Workload identity."
  type        = string
  default     = ""
}

variable "anthropic_organization_id" {
  description = "Anthropic organization UUID that owns the federation rule."
  type        = string
  default     = ""
}

variable "anthropic_service_account_id" {
  description = "Service account (svac_...) the minted token acts as."
  type        = string
  default     = ""
}

variable "anthropic_workspace_id" {
  description = <<-EOT
    Workspace (wrkspc_...) to scope the minted token to. Only required when the
    federation rule covers more than one non-default workspace; leave empty and
    the server picks the rule's sole workspace.
  EOT
  type        = string
  default     = ""
}

variable "rate_user_hour" {
  description = <<-EOT
    Receipts one person may have parsed per hour. Generous for a real meal —
    nobody splits ten bills in an hour — and low enough that a script is stopped
    in its first minute. Zero disables this tier.
  EOT
  type        = number
  default     = 10
}

variable "rate_user_day" {
  description = "Receipts one person may have parsed per day. Zero disables this tier."
  type        = number
  default     = 30
}

variable "rate_global_day" {
  description = <<-EOT
    Receipts anyone may have parsed per day, across every user. This is the
    number that bounds the bill: per-user limits are fairness, and do nothing
    against twenty throwaway accounts.

    At roughly 2.6 cents a receipt, 200 is about $5.20 — the most a bad day can
    cost before the bot politely stops. Raise it when real usage justifies it.
  EOT
  type        = number
  default     = 200
}

variable "parser_max_concurrency" {
  description = <<-EOT
    How many parsers SQS may run at once. Bounds the rate of paid vision calls,
    and keeps the parser from consuming the whole account concurrency pool and
    throttling the webhook — this account's Lambda limit is 10 in total, shared
    between both functions.

    Applied to the event source mapping rather than as reserved concurrency:
    AWS requires 10 unreserved executions account-wide, so at this limit any
    reservation is rejected. Minimum accepted value is 2.
  EOT
  type        = number
  default     = 5

  validation {
    condition     = var.parser_max_concurrency >= 2
    error_message = "SQS maximum_concurrency must be at least 2."
  }
}

variable "vision_calls_per_hour_alarm" {
  description = <<-EOT
    Vision calls in one hour above which the cost alarm fires. Each call is a
    paid request, so this is the tripwire for someone spamming receipts at a
    bot that does not yet rate-limit them.

    Set well above ordinary use and well below anything that would hurt: at
    roughly 2.6 cents a receipt, 50 an hour is about $1.30 — noticeable, not
    damaging.
  EOT
  type        = number
  default     = 50
}

variable "log_retention_days" {
  description = "CloudWatch log retention. Lambda's default is never-expire, which you pay for forever."
  type        = number
  default     = 14
}
