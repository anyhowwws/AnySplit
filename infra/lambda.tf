# Log groups are declared explicitly rather than left to Lambda's implicit
# creation: the implicit ones default to never-expire, and you pay for that
# forever. Declaring them also lets the IAM policies scope to a real ARN.
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "parser" {
  name              = "/aws/lambda/${local.name}-parser"
  retention_in_days = var.log_retention_days
}

data "archive_file" "api" {
  type        = "zip"
  source_dir  = local.api_bundle_dir
  output_path = "${path.module}/.build/api.zip"
}

data "archive_file" "parser" {
  type        = "zip"
  source_dir  = local.parser_bundle_dir
  output_path = "${path.module}/.build/parser.zip"
}

locals {
  # Secrets are passed as SSM *paths*, never values — see backend/src/lib/secrets.ts.
  common_env = {
    BILLS_TABLE   = aws_dynamodb_table.bills.name
    MINIAPP_URL   = "https://${aws_cloudfront_distribution.miniapp.domain_name}"
    SSM_BOT_TOKEN = data.aws_ssm_parameter.bot_token.name
    TTL_SECONDS   = tostring(var.ttl_days * 86400)
  }
}

# Handles the Telegram webhook AND the Mini App REST routes. Must ack Telegram
# in under ~3s, so the webhook path only writes a row and enqueues.
resource "aws_lambda_function" "api" {
  function_name = "${local.name}-api"
  role          = aws_iam_role.api.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"] # cheaper per ms, and nothing here is native

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  timeout     = 15
  memory_size = 512

  environment {
    variables = merge(local.common_env, {
      PARSE_QUEUE_URL    = aws_sqs_queue.parse.id
      SSM_WEBHOOK_SECRET = data.aws_ssm_parameter.webhook_secret.name
      TEST_USER_ID       = var.test_user_id
    })
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

# SQS-triggered. Does the vision call and the DB write, then edits the original
# Telegram message. 60s is generous for one image; the queue's visibility
# timeout (180s) stays comfortably above it.
resource "aws_lambda_function" "parser" {
  function_name = "${local.name}-parser"
  role          = aws_iam_role.parser.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.parser.output_path
  source_code_hash = data.archive_file.parser.output_base64sha256

  timeout = 60
  # Receipt images are held in memory as base64 before the API call, and more
  # memory also buys proportionally more CPU for the JSON work.
  memory_size = 1024

  environment {
    variables = merge(local.common_env, {
      SSM_ANTHROPIC_KEY = data.aws_ssm_parameter.anthropic_key.name
      VISION_MODEL      = var.vision_model
    })
  }

  depends_on = [aws_cloudwatch_log_group.parser]
}
