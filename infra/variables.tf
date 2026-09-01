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
    Backstop retention for bills that are never finished. A completed bill is
    deleted outright the moment its messages are sent, so this only covers
    someone photographing a receipt and abandoning it — which needs hours, not
    days.
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

variable "alarm_email" {
  description = "Address that receives DLQ alarms. Leave empty to skip the subscription."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "CloudWatch log retention. Lambda's default is never-expire, which you pay for forever."
  type        = number
  default     = 14
}
