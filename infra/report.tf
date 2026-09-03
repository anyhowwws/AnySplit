# --------------------------------------------------------------------
# Daily usage report: API calls, parses attempted/succeeded, splits
# finalised, new users, total unique users.
#
# Reads the metrics monitoring.tf already derives from the structured logs —
# there is no separate table to scan, and "total unique users" falls out of
# summing NewUsers over its whole retention rather than counting rows. See
# backend/src/handlers/report.ts.
#
# Deliberately its own Lambda and role rather than a branch inside `api`: it
# needs cloudwatch:GetMetricData and sns:Publish and nothing else, so it
# cannot read a bill or touch the bot token even if it had a bug in it.
# --------------------------------------------------------------------

locals {
  # Falls back to the alarm address so a deployment that only ever set one
  # email doesn't silently get a topic nobody is subscribed to.
  report_email = var.report_email != "" ? var.report_email : var.alarm_email
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

  # Six GetMetricData calls and one Publish; generous headroom over tight.
  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      REPORTS_TOPIC_ARN = aws_sns_topic.reports.arn
      HTTP_API_ID       = aws_apigatewayv2_api.http.id
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
