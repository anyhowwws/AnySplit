# --------------------------------------------------------------------
# Daily usage report: API calls, parses attempted/succeeded, splits
# finalised, new users, total unique users.
#
# The daily numbers come from the metrics monitoring.tf derives from the
# structured logs. "Total unique users" does not: a metric filter starts at zero
# when Terraform creates it and cannot see a log line written before that, so
# summing NewUsers over its retention silently drops everyone who signed up
# before the filter was deployed. The running total is kept in the table beside
# the rows it counts — see backend/src/lib/usercount.ts.
#
# Deliberately its own Lambda and role rather than a branch inside `api`. It
# needs cloudwatch:GetMetricData, sns:Publish, and a GetItem on exactly one key,
# so it cannot read a bill or touch the bot token even if it had a bug in it.
# --------------------------------------------------------------------

locals {
  # Falls back to the alarm address so a deployment that only ever set one
  # email doesn't silently get a topic nobody is subscribed to.
  report_email = var.report_email != "" ? var.report_email : var.alarm_email

  # Must match USER_COUNT_KEY in backend/src/lib/usercount.ts. It is repeated
  # here rather than passed in because it is what the IAM condition below pins
  # the report role's table access to — a variable would let a deployment widen
  # that read without touching this file.
  user_count_key = "meta#users"
}

resource "aws_sns_topic" "reports" {
  name = "${local.name}-reports"
}

# Same confirmation-link caveat as the alarm topic in monitoring.tf: nothing
# arrives until the subscription is confirmed from the inbox.
resource "aws_sns_topic_subscription" "report_email" {
  count     = local.report_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.reports.arn
  protocol  = "email"
  endpoint  = local.report_email
}

resource "aws_cloudwatch_log_group" "report" {
  name              = "/aws/lambda/${local.name}-report"
  retention_in_days = var.log_retention_days
}

data "archive_file" "report" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/dist/report"
  output_path = "${path.module}/.build/report.zip"
}

resource "aws_iam_role" "report" {
  name               = "${local.name}-report"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "report" {
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.report.arn}:*"]
  }

  # No resource-level restriction exists for GetMetricData — it isn't scoped
  # to a namespace or metric, only to the account the caller is in.
  statement {
    sid       = "ReadMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:GetMetricData"]
    resources = ["*"]
  }

  # The running total of unique users, and provably nothing else in the table.
  # `dynamodb:LeadingKeys` matches the item's partition key, so this role can
  # read the one counter item and cannot read a bill — which is the whole reason
  # the report reads a counter rather than counting `usr#` rows itself. A Scan
  # would be the natural way to count them and cannot be scoped this way: IAM
  # has no notion of a key prefix, so granting it would grant every bill.
  statement {
    sid       = "ReadUserCount"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.bills.arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = [local.user_count_key]
    }
  }

  statement {
    sid       = "PublishReport"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.reports.arn]
  }
}

resource "aws_iam_role_policy" "report" {
  name   = "${local.name}-report"
  role   = aws_iam_role.report.id
  policy = data.aws_iam_policy_document.report.json
}

resource "aws_lambda_function" "report" {
  function_name = "${local.name}-report"
  role          = aws_iam_role.report.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.report.output_path
  source_code_hash = data.archive_file.report.output_base64sha256

  # Five GetMetricData calls, one GetItem and one Publish; generous headroom
  # over tight.
  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      REPORTS_TOPIC_ARN = aws_sns_topic.reports.arn
      HTTP_API_ID       = aws_apigatewayv2_api.http.id
      BILLS_TABLE       = aws_dynamodb_table.bills.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.report]
}

# Fires once a day. 01:00 UTC is 09:00 in Singapore, the timezone this bot is
# built for — see DESIGN.md.
resource "aws_cloudwatch_event_rule" "report_daily" {
  name                = "${local.name}-report-daily"
  schedule_expression = "cron(0 1 * * ? *)"
}

resource "aws_cloudwatch_event_target" "report_daily" {
  rule = aws_cloudwatch_event_rule.report_daily.name
  arn  = aws_lambda_function.report.arn
}

resource "aws_lambda_permission" "report_daily" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.report.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.report_daily.arn
}
