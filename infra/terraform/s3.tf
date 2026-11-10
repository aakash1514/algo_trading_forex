# Two private buckets: backtest results (ws-gateway, through the instance role) and backups (14 days).
# Both: every public access blocked, ACLs off (BucketOwnerEnforced), SSE-S3, and a policy refusing any
# request that isn't TLS. Neither is force_destroy: a destroy needs them emptied first (docs/DEPLOY.md).
locals {
  buckets = {
    results = local.results_bucket
    backups = local.backups_bucket
  }
}

# Account-wide guard as well: no bucket in this account (the state bucket included) can be made public
resource "aws_s3_account_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets

  bucket        = each.value
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = aws_s3_bucket.this

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = false
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = ["arn:aws:s3:::${local.buckets[each.key]}", "arn:aws:s3:::${local.buckets[each.key]}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  # S3 refuses a bucket policy while the public access block is still being written
  depends_on = [aws_s3_bucket_public_access_block.this]
}

# Backups are versioned: the instance role can PutObject (no DeleteObject), and an overwrite would
# otherwise destroy the previous backup. Every version, current or not, is gone after 14 days.
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.this["backups"].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.this["backups"].id

  rule {
    id     = "expire-after-14-days"
    status = "Enabled"
    filter {}

    expiration {
      days = 14
    }
    noncurrent_version_expiration {
      noncurrent_days = 14
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # The delete markers left once every version of an object has expired
  rule {
    id     = "remove-expired-delete-markers"
    status = "Enabled"
    filter {}

    expiration {
      expired_object_delete_marker = true
    }
  }

  depends_on = [aws_s3_bucket_versioning.backups]
}
