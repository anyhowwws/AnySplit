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
}
