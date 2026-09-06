# ---------------------------------------------------------------- usage
#
# Usage and health are measured from the logs rather than from stored data.
# Bills expire 24 hours after the last action on them, so there is no table to
# count rows in — deliberately. Metric filters turn the structured log lines
# into real metrics, which CloudWatch keeps for 15 months against the logs' 14
# days, and which can be graphed and alarmed on.
#
# None of these carry user identity: they are counts of events, and the user
# ids in the underlying lines are HMAC'd (see backend/src/lib/userref.ts).
#
# A metric only exists once its filter has matched something, and a metric with
# no data reads as "missing" rather than zero — which is why every alarm below
# sets `treat_missing_data = "notBreaching"`. Without it a quiet day would page.

locals {
  usage_metrics = {
    # A photo arrived and was queued for parsing — i.e. someone started a split.
    bills_started = {
      log_group = aws_cloudwatch_log_group.api.name
      msg       = "parse enqueued"
      metric    = "BillsStarted"
    }
    # The vision call succeeded and produced items.
    receipts_parsed = {
      log_group = aws_cloudwatch_log_group.parser.name
      msg       = "receipt parsed"
      metric    = "ReceiptsParsed"
    }
    # A split was completed and the per-person messages went out. The one that
    # actually means "the app did its job".
    bills_finalised = {
      log_group = aws_cloudwatch_log_group.api.name
      msg       = "bill finalised"
      metric    = "BillsFinalised"
    }
    # A receipt we gave up on after the retry. The gap between started and
    # parsed is where users silently drop out.
    parse_failures = {
      log_group = aws_cloudwatch_log_group.parser.name
      msg       = "unrecoverable parse, not retrying"
      metric    = "ParseFailures"
    }
    # A pseudonym recordUse had never seen before — see the conditional create
    # in db.ts. Summed over a day this is "new users", which is what the daily
    # report uses it for. It is NOT the running total: this metric began at zero
    # when Terraform first created the filter and cannot see a `new user` line
    # logged before that, so anyone who signed up earlier is invisible to it.
    # The total is counted in the table instead — see lib/usercount.ts.
    new_users = {
      log_group = aws_cloudwatch_log_group.api.name
      msg       = "new user"
      metric    = "NewUsers"
    }

    # ------------------------------------------------------------- security
    #
    # Both of these should read zero forever. They are logged either way; the
    # point of lifting them into metrics is that a log line nobody queries is
    # not a detection.

    # Someone reached the webhook without the shared secret. Telegram always
    # sends it, so this means the API Gateway URL is known to somebody else.
    bad_webhook_secret = {
      log_group = aws_cloudwatch_log_group.api.name
      msg       = "webhook rejected: bad secret token"
      metric    = "BadWebhookSecret"
    }
    # Someone asked for a bill that is not theirs. Bill ids carry 72 bits of
    # entropy, so this is not a typo.
    bill_access_denied = {
      log_group = aws_cloudwatch_log_group.api.name
      msg       = "bill access denied"
      metric    = "BillAccessDenied"
    }

    # --------------------------------------------------------------- health
    #
    # Telegram redelivers any update it does not see acknowledged in about five
    # seconds. Sustained slow acks are the leading edge of the failure the
    # README describes as "what a dead bot looks like": the retry arrives, gets
    # dropped as a duplicate, and the user sees nothing at all.
    slow_acks = {
      log_group = aws_cloudwatch_log_group.api.name
      msg       = "update handled but over telegram ack budget"
      metric    = "SlowAcks"
    }

    # Every vision call, successful or not. ReceiptsParsed counts only the ones
    # that produced items; this one counts the ones that cost money.
    vision_calls = {
      log_group = aws_cloudwatch_log_group.parser.name
      msg       = "vision call complete"
      metric    = "VisionCalls"
    }
  }
}

# The only filter that extracts a value rather than counting occurrences, so it
# cannot share the loop above. Input tokens dominate the bill — around 92% of it
# — and scale with image area, so this doubles as the signal that cropping has
# stopped working: a step change here without a matching rise in VisionCalls
# means the images got bigger, not more numerous.
resource "aws_cloudwatch_log_metric_filter" "vision_input_tokens" {
  name           = "${local.name}-vision-input-tokens"
  log_group_name = aws_cloudwatch_log_group.parser.name
  pattern        = "{ $.msg = \"vision call complete\" }"

  metric_transformation {
    name          = "VisionInputTokens"
    namespace     = "AnySplit"
    value         = "$.inputTokens"
    unit          = "Count"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "usage" {
  for_each = local.usage_metrics

  name           = "${local.name}-${each.key}"
  log_group_name = each.value.log_group
  # JSON filter against our structured logs: match on the `msg` field only.
  pattern = "{ $.msg = \"${each.value.msg}\" }"

  metric_transformation {
    name      = each.value.metric
    namespace = "AnySplit"
    value     = "1"
    unit      = "Count"
    # Without this, gaps read as "no data" rather than "nothing happened",
    # which makes the graphs look broken on a quiet day.
    default_value = "0"
  }
}

# ---------------------------------------------------------------- alarms

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

# Confirm the subscription from your inbox after the first apply — SNS won't
# deliver until you click the link.
resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# Anything in the DLQ means a receipt failed three times. At this volume that's
# always worth a look, so the threshold is one message, not a rate.
resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "${local.name}-parse-dlq-not-empty"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 300
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.parse_dlq.name
  }

  alarm_description = "A receipt parse failed repeatedly and landed in the DLQ."
  alarm_actions     = [aws_sns_topic.alarms.arn]
  ok_actions        = [aws_sns_topic.alarms.arn]
}

# Catches the case where the API Lambda is throwing before it can even log —
# e.g. a bad env var after a deploy. Telegram would be silently retrying.
resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${local.name}-api-errors"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 5
  evaluation_periods  = 1
  period              = 300
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.api.function_name
  }

  alarm_description = "The api Lambda is erroring; the webhook may be failing."
  alarm_actions     = [aws_sns_topic.alarms.arn]
}

# ------------------------------------------------------- security tripwires
#
# Threshold zero on both: these count events that should never happen once, so
# any occurrence is the signal. CloudWatch notifies on the transition into
# ALARM rather than on every breaching period, so a sustained probe produces
# one email, not one every five minutes.

resource "aws_cloudwatch_metric_alarm" "bad_webhook_secret" {
  alarm_name          = "${local.name}-bad-webhook-secret"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 300
  namespace           = "AnySplit"
  metric_name         = "BadWebhookSecret"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_description = "Someone posted to the webhook without the shared secret. Telegram always sends it, so the API Gateway URL is known to somebody else. Rotate the webhook secret and re-run setWebhook."
  alarm_actions     = [aws_sns_topic.alarms.arn]
  ok_actions        = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "bill_access_denied" {
  alarm_name          = "${local.name}-bill-access-denied"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 300
  namespace           = "AnySplit"
  metric_name         = "BillAccessDenied"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_description = "A request asked for a bill belonging to someone else. Bill ids carry 72 bits of entropy, so this is not an accident."
  alarm_actions     = [aws_sns_topic.alarms.arn]
  ok_actions        = [aws_sns_topic.alarms.arn]
}

# ------------------------------------------------------------------- health

# One slow ack is a cold start. Several in five minutes means Telegram is
# redelivering faster than the bot is answering, and users are seeing nothing.
resource "aws_cloudwatch_metric_alarm" "slow_acks" {
  alarm_name          = "${local.name}-slow-acks"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 3
  evaluation_periods  = 1
  period              = 300
  namespace           = "AnySplit"
  metric_name         = "SlowAcks"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_description = "Updates are being handled too slowly for Telegram's acknowledgement window, so it is redelivering them."
  alarm_actions     = [aws_sns_topic.alarms.arn]
  ok_actions        = [aws_sns_topic.alarms.arn]
}

# The gap the DLQ alarm cannot see. An unrecoverable parse is *handled* — the
# bill is marked errored and the message consumed — so it never reaches the
# DLQ. Without this, anything that breaks every vision call at once — a deleted
# or edited federation rule, a disabled service account, a role rename that no
# longer matches the rule's `sub` pin, a withdrawn model — would fail every
# receipt cleanly and leave both original alarms green.
#
# Blurry photos fail too, so the threshold is set for a run of them rather than
# a single one: over a quarter of an hour, three is a pattern.
resource "aws_cloudwatch_metric_alarm" "parse_failures" {
  alarm_name          = "${local.name}-parse-failures"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 2
  evaluation_periods  = 1
  period              = 900
  namespace           = "AnySplit"
  metric_name         = "ParseFailures"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_description = "Several receipts in a row failed to parse. If they are not all bad photos, the vision path itself is broken."
  alarm_actions     = [aws_sns_topic.alarms.arn]
  ok_actions        = [aws_sns_topic.alarms.arn]
}

# --------------------------------------------------------------------- cost
#
# The only alarm here that guards money rather than correctness. Nothing in the
# bot currently limits how many receipts one person can send, so this is the
# detection half of that problem — it does not stop a flood, it tells you one is
# happening while it still costs cents.
resource "aws_cloudwatch_metric_alarm" "vision_call_volume" {
  alarm_name          = "${local.name}-vision-call-volume"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.vision_calls_per_hour_alarm
  evaluation_periods  = 1
  period              = 3600
  namespace           = "AnySplit"
  metric_name         = "VisionCalls"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_description = "Vision calls in the last hour exceeded the expected ceiling. Each one is a paid API call."
  alarm_actions     = [aws_sns_topic.alarms.arn]
  ok_actions        = [aws_sns_topic.alarms.arn]
}
