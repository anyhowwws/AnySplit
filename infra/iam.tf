data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------- api role

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  statement {
    sid    = "Bills"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.bills.arn]
  }

  statement {
    sid       = "Enqueue"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.parse.arn]
  }

  statement {
    sid    = "ReadSecrets"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
    ]
    resources = [
      data.aws_ssm_parameter.bot_token.arn,
      data.aws_ssm_parameter.webhook_secret.arn,
    ]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "${local.name}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# ------------------------------------------------------------- parser role

resource "aws_iam_role" "parser" {
  name               = "${local.name}-parser"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "parser" {
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.parser.arn}:*"]
  }

  statement {
    sid    = "Bills"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.bills.arn]
  }

  statement {
    sid    = "ConsumeQueue"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.parse.arn]
  }

  statement {
    sid    = "ReadSecrets"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
    ]
    resources = [
      data.aws_ssm_parameter.bot_token.arn,
      data.aws_ssm_parameter.anthropic_key.arn,
    ]
  }
}

resource "aws_iam_role_policy" "parser" {
  name   = "${local.name}-parser"
  role   = aws_iam_role.parser.id
  policy = data.aws_iam_policy_document.parser.json
}
