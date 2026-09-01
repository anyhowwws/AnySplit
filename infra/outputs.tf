# The $default stage's invoke_url carries a trailing slash. The Mini App
# concatenates paths onto this, so trim it or every request goes to `//api/...`.
output "api_base_url" {
  description = "API Gateway base URL. Build the Mini App with VITE_API_BASE set to this."
  value       = trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")
}

output "webhook_url" {
  description = "Pass this to Telegram's setWebhook."
  value       = "${trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")}/webhook"
}

output "miniapp_url" {
  description = "Register this with BotFather via /newapp."
  value       = "https://${aws_cloudfront_distribution.miniapp.domain_name}"
}

output "miniapp_bucket" {
  description = "Target for `aws s3 sync miniapp/dist/`."
  value       = aws_s3_bucket.miniapp.bucket
}

output "cloudfront_distribution_id" {
  description = "Needed to invalidate index.html after a Mini App deploy."
  value       = aws_cloudfront_distribution.miniapp.id
}

output "github_actions_role_arn" {
  description = "Set as the AWS_ROLE_ARN repository variable so CI can assume it."
  value       = aws_iam_role.github_actions.arn
}

output "bills_table" {
  value = aws_dynamodb_table.bills.name
}

output "parse_queue_url" {
  value = aws_sqs_queue.parse.id
}

output "dlq_url" {
  description = "Inspect failed parses here."
  value       = aws_sqs_queue.parse_dlq.id
}
