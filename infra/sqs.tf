resource "aws_sqs_queue" "parse_dlq" {
  name                      = "${local.name}-parse-dlq"
  message_retention_seconds = 14 * 24 * 3600
}

resource "aws_sqs_queue" "parse" {
  name = "${local.name}-parse-queue"

  # Must exceed the parser's timeout, or SQS redelivers a job that is still
  # running and we pay for a duplicate vision call.
  visibility_timeout_seconds = 180

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.parse_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_lambda_event_source_mapping" "parse" {
  event_source_arn = aws_sqs_queue.parse.arn
  function_name    = aws_lambda_function.parser.arn

  # One receipt per invocation. Batching would mean a single bad image can hold
  # up other people's bills behind it.
  batch_size = 1

  # Lets the parser fail one record without forcing redelivery of its siblings.
  function_response_types = ["ReportBatchItemFailures"]

  # Caps how many parsers SQS will run at once, which bounds both the vision
  # spend rate and — more importantly here — how much of the account's
  # concurrency the parser can take.
  #
  # This account's Lambda limit is 10 concurrent executions in total, shared
  # with the api function. Left uncapped, a burst of receipts would take all
  # ten, and the webhook would start throttling: Telegram would stop getting
  # acknowledged, retry, and the bot would appear dead to everyone — including
  # people not involved in the burst.
  #
  # Capped on the event source rather than as reserved_concurrent_executions on
  # the function, because AWS requires 10 unreserved executions to remain
  # account-wide and reserving any at this limit is rejected outright.
  scaling_config {
    maximum_concurrency = var.parser_max_concurrency
  }
}
