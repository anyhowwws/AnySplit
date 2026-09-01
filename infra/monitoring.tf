# ---------------------------------------------------------------- usage
#
# Usage is measured from the logs rather than from stored data. Bills are
# deleted as soon as their messages send, so there is no table to count rows in
# — and deliberately so. Metric filters turn the structured log lines into real
# metrics, which CloudWatch keeps for 15 months against the logs' 14 days, and
# which can be graphed and alarmed on.
#
# None of these carry user identity: they are counts of events, and the user
# ids in the underlying lines are HMAC'd (see backend/src/lib/userref.ts).

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
