# One table, one item per bill. No sort key, no GSI — every read is a single
# GetItem by billId. Update dedupe markers share the table under a `upd#` prefix.
resource "aws_dynamodb_table" "bills" {
  name         = "${local.name}-bills"
  billing_mode = "PAY_PER_REQUEST" # effectively free at this volume
  hash_key     = "billId"

  attribute {
    name = "billId"
    type = "S"
  }

  # DynamoDB deletes expired items on its own schedule — typically within 48
  # hours, not immediately. The backend re-checks `ttl` on every read and treats
  # an expired item as absent, so the retention promise holds regardless.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    # Deliberately off: the data is disposable by design and PITR would keep
    # copies of bills past the retention window we advertise.
    enabled = false
  }
}
