# OAC, not the legacy OAI. OAI is deprecated and doesn't support SSE-KMS.
resource "aws_cloudfront_origin_access_control" "miniapp" {
  name                              = "${local.name}-miniapp"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Managed policy: CachingOptimized. Hashed asset filenames from Vite make long
# TTLs safe; index.html is invalidated on deploy.
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "miniapp" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  comment             = "${local.name} mini app"

  # No custom domain: the default *.cloudfront.net certificate is valid HTTPS,
  # which is all Telegram requires. That removes ACM, Route 53, and the
  # us-east-1 provider alias from this stack entirely.
  price_class = "PriceClass_200" # includes Asia-Pacific edges

  origin {
    domain_name              = aws_s3_bucket.miniapp.bucket_regional_domain_name
    origin_id                = "s3-miniapp"
    origin_access_control_id = aws_cloudfront_origin_access_control.miniapp.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-miniapp"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
  }

  # SPA routing: S3 returns 403 for a missing key when the caller can't list the
  # bucket, so both codes have to map back to index.html with a 200.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
