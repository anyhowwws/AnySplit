resource "aws_s3_bucket" "miniapp" {
  bucket_prefix = "${local.name}-miniapp-"
}

# Fully private. CloudFront reaches it through Origin Access Control; there is no
# public path to the bucket at all.
resource "aws_s3_bucket_public_access_block" "miniapp" {
  bucket                  = aws_s3_bucket.miniapp.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "miniapp" {
  bucket = aws_s3_bucket.miniapp.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "miniapp" {
  statement {
    sid       = "AllowCloudFrontOAC"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.miniapp.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    # Scoped to this distribution specifically, so another account's
    # distribution can't be pointed at the bucket.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.miniapp.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "miniapp" {
  bucket = aws_s3_bucket.miniapp.id
  policy = data.aws_iam_policy_document.miniapp.json
}
