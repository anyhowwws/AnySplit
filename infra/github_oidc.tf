# The role GitHub Actions assumes to plan and apply. No long-lived AWS keys
# exist for CI: GitHub mints a short-lived OIDC token per job, AWS verifies it
# against the provider below, and STS hands back credentials good for one run.

data "aws_caller_identity" "current" {}

locals {
  # The state bucket is created out-of-band and its name is deliberately not in
  # git (see backend.tf), but it is derivable — so CI's policy can name it
  # without the repo hardcoding an account id.
  state_bucket_arn = "arn:aws:s3:::${local.name}-tfstate-${data.aws_caller_identity.current.account_id}"

  anysplit_role_arns = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.name}-*"

  # GitHub issues an *immutable* subject claim: the owner and repository names
  # each carry their numeric id, as
  #
  #   repo:owner@<owner-id>/name@<repo-id>:ref:refs/heads/main
  #
  # rather than the `repo:owner/name:...` form most guides still show. The ids
  # are what make it immutable, and they are the reason to prefer this form:
  # names can be released and re-registered, so a policy matching names alone
  # would keep trusting this repository's path after someone else claimed it.
  #
  #   gh api repos/<owner>/<name> --jq '{owner_id: .owner.id, repo_id: .id}'
  gh_owner = split("/", var.github_repo)[0]
  gh_name  = split("/", var.github_repo)[1]
  gh_subject = join("", [
    "repo:", local.gh_owner, "@", var.github_owner_id,
    "/", local.gh_name, "@", var.github_repo_id,
  ])
}

# One provider per account, not per repo. `client_id_list` is the `aud` claim
# the workflow requests; aws-actions/configure-aws-credentials always asks for
# sts.amazonaws.com.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  # AWS stopped verifying this thumbprint for token.actions.githubusercontent.com
  # once it moved to a trusted CA, but the argument is still persisted, and a
  # rotation upstream would otherwise show as a spurious diff.
  lifecycle {
    ignore_changes = [thumbprint_list]
  }
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The `sub` claim is the only thing standing between this role and any
    # other GitHub repository in the world, so it is pinned to two exact
    # subjects rather than a wildcard. A wildcard would match every branch,
    # tag and environment too, meaning anyone able to push a branch could
    # assume a role that can apply infrastructure.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "${local.gh_subject}:ref:refs/heads/main",
        "${local.gh_subject}:pull_request",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "${local.name}-github-actions"
  description        = "Assumed by GitHub Actions via OIDC to plan and apply ${local.name}."
  assume_role_policy = data.aws_iam_policy_document.github_assume.json

  # A plan on a large-ish stack plus an apply and a CloudFront wait can outrun
  # the default hour.
  max_session_duration = 7200
}

data "aws_iam_policy_document" "github_actions" {
  # ------------------------------------------------------------------ state
  statement {
    sid       = "TerraformStateBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [local.state_bucket_arn]
  }

  statement {
    sid    = "TerraformStateObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      # The lock is an object now (`use_lockfile`), so releasing it is a delete.
      "s3:DeleteObject",
    ]
    resources = ["${local.state_bucket_arn}/${local.name}/*"]
  }

  # ------------------------------------------------------------------- read
  # `terraform plan` has to refresh every managed resource before it can say
  # what would change, so read is necessarily account-wide. Nothing here can
  # mutate anything, and it is what keeps plan-on-PR honest.
  statement {
    sid    = "ReadForPlan"
    effect = "Allow"
    actions = [
      "apigateway:GET",
      "cloudfront:Get*",
      "cloudfront:List*",
      # Refreshing an alarm reads its tags, which is a separate action from
      # DescribeAlarms and denied by default.
      "cloudwatch:Describe*",
      "cloudwatch:Get*",
      "cloudwatch:List*",
      "dynamodb:Describe*",
      "dynamodb:ListTagsOfResource",
      "iam:Get*",
      "iam:List*",
      "lambda:Get*",
      "lambda:List*",
      "logs:Describe*",
      "logs:ListTagsForResource",
      "s3:GetBucket*",
      "s3:GetAccelerateConfiguration",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "sns:Get*",
      "sns:List*",
      "sqs:Get*",
      "sqs:List*",
      "ssm:DescribeParameters",
      "sts:GetCallerIdentity",
      "tag:GetResources",
    ]
    resources = ["*"]
  }

  # ---------------------------------------------------------------- secrets
  # Same indirection the Lambdas use: read the parameter, never write it.
  statement {
    sid       = "ReadSecrets"
    effect    = "Allow"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${local.name}/*"]
  }

  # ---------------------------------------------------------------- compute
  statement {
    sid    = "ManageFunctions"
    effect = "Allow"
    actions = [
      "lambda:CreateFunction",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
      "lambda:DeleteFunction",
      "lambda:AddPermission",
      "lambda:RemovePermission",
      "lambda:TagResource",
      "lambda:UntagResource",
      "lambda:PutFunctionConcurrency",
      "lambda:DeleteFunctionConcurrency",
    ]
    resources = ["arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.name}-*"]
  }

  # Event source mappings are identified by a generated UUID, so they cannot be
  # matched by name prefix. Constrained by the function they attach to instead.
  statement {
    sid    = "ManageEventSourceMappings"
    effect = "Allow"
    actions = [
      "lambda:CreateEventSourceMapping",
      "lambda:UpdateEventSourceMapping",
      "lambda:DeleteEventSourceMapping",
    ]
    resources = ["*"]

    condition {
      test     = "StringLike"
      variable = "lambda:FunctionArn"
      values   = ["arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.name}-*"]
    }
  }

  # ------------------------------------------------------------------- data
  # Deliberately no dynamodb:DeleteTable. Every bill in flight lives in that
  # table; dropping it should take a human at a terminal, not a merge to main.
  # If a change ever forces table replacement, CI fails loudly here — which is
  # the intended outcome, not a gap to widen.
  statement {
    sid    = "ManageTable"
    effect = "Allow"
    actions = [
      "dynamodb:CreateTable",
      "dynamodb:UpdateTable",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:TagResource",
      "dynamodb:UntagResource",
    ]
    resources = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${local.name}-*"]
  }

  statement {
    sid    = "ManageQueues"
    effect = "Allow"
    actions = [
      "sqs:CreateQueue",
      "sqs:SetQueueAttributes",
      "sqs:TagQueue",
      "sqs:UntagQueue",
    ]
    resources = ["arn:aws:sqs:${var.region}:${data.aws_caller_identity.current.account_id}:${local.name}-*"]
  }

  # ------------------------------------------------------------------- edge
  statement {
    sid       = "ManageHttpApi"
    effect    = "Allow"
    actions   = ["apigateway:POST", "apigateway:PATCH", "apigateway:PUT", "apigateway:DELETE"]
    resources = ["arn:aws:apigateway:${var.region}::/apis", "arn:aws:apigateway:${var.region}::/apis/*"]
  }

  # CloudFront's mutating actions are account-scoped — CreateDistribution has no
  # resource to name before the distribution exists — so this cannot be narrowed
  # by ARN the way the statements above are.
  statement {
    sid    = "ManageCdn"
    effect = "Allow"
    actions = [
      "cloudfront:CreateDistribution",
      "cloudfront:UpdateDistribution",
      "cloudfront:DeleteDistribution",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:UpdateOriginAccessControl",
      "cloudfront:DeleteOriginAccessControl",
      "cloudfront:CreateInvalidation",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
    ]
    resources = ["*"]
  }

  # The Mini App bucket: managed by Terraform, then synced into by the deploy
  # step at the end of the workflow.
  statement {
    sid    = "ManageMiniappBucket"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:PutBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketTagging",
      "s3:PutBucketVersioning",
      "s3:PutEncryptionConfiguration",
      "s3:DeleteBucketPolicy",
      "s3:ListBucket",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [
      "arn:aws:s3:::${local.name}-miniapp-*",
      "arn:aws:s3:::${local.name}-miniapp-*/*",
    ]
  }

  # ---------------------------------------------------------------- identity
  # Terraform manages the two Lambda execution roles, so CI must be able to
  # write IAM — the most dangerous permission here by some distance. Scoped to
  # the `anysplit-*` name prefix so a compromised workflow cannot mint itself an
  # administrator role, and PassRole is limited to the same set.
  statement {
    sid    = "ManageLambdaRoles"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
    ]
    resources = [local.anysplit_role_arns]
  }

  statement {
    sid       = "PassLambdaRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [local.anysplit_role_arns]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  # ----------------------------------------------------------- observability
  statement {
    sid    = "ManageLogsAndAlarms"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
      # The usage metrics in monitoring.tf are log metric filters, which are
      # addressed by their log group's ARN.
      "logs:PutMetricFilter",
      "logs:DeleteMetricFilter",
    ]
    resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.name}-*"]
  }

  statement {
    sid    = "ManageAlarms"
    effect = "Allow"
    actions = [
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:DeleteAlarms",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:TagResource",
      "sns:CreateTopic",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
      "sns:Unsubscribe",
      "sns:TagResource",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_actions" {
  name   = "${local.name}-github-actions"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions.json
}
