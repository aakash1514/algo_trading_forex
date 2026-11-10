# ECR and S3 (Group B), against the mocked provider: values the configuration sets, after a mock apply.
mock_provider "aws" {
  source = "./tests/mocks"
}

variables {
  alert_email = "alerts@example.com"
}

run "ecr_repositories" {
  assert {
    condition = sort([for r in aws_ecr_repository.this : r.name]) == sort([
      "forexedge/auth-service", "forexedge/market-service", "forexedge/domain-service", "forexedge/order-service",
      "forexedge/ws-gateway", "forexedge/replay-service", "forexedge/ml-service", "forexedge/research-agent",
      "forexedge/frontend", "forexedge/ops",
    ])
    error_message = "ECR must hold exactly the ten compose images under forexedge/."
  }

  assert {
    condition     = alltrue([for r in aws_ecr_repository.this : r.image_tag_mutability == "IMMUTABLE"])
    error_message = "Every ECR repository must have immutable tags."
  }

  assert {
    condition     = alltrue([for r in aws_ecr_repository.this : r.image_scanning_configuration[0].scan_on_push])
    error_message = "Every ECR repository must scan on push."
  }

  assert {
    condition = alltrue([for p in aws_ecr_lifecycle_policy.this :
      jsondecode(p.policy).rules[0].selection.countType == "imageCountMoreThan" &&
    jsondecode(p.policy).rules[0].selection.countNumber == 5])
    error_message = "Every ECR repository must keep exactly the last 5 images."
  }

  assert {
    condition     = length(aws_ecr_lifecycle_policy.this) == 10
    error_message = "Every ECR repository needs its lifecycle policy."
  }
}

run "buckets_block_public_access" {
  assert {
    condition = length(aws_s3_bucket_public_access_block.this) == 2 && alltrue([for b in aws_s3_bucket_public_access_block.this :
    b.block_public_acls && b.block_public_policy && b.ignore_public_acls && b.restrict_public_buckets])
    error_message = "Both buckets must block every kind of public access."
  }

  assert {
    condition = (aws_s3_account_public_access_block.this.block_public_acls && aws_s3_account_public_access_block.this.block_public_policy &&
    aws_s3_account_public_access_block.this.ignore_public_acls && aws_s3_account_public_access_block.this.restrict_public_buckets)
    error_message = "The account-level public access block must have all four settings on."
  }

  assert {
    condition     = alltrue([for o in aws_s3_bucket_ownership_controls.this : o.rule[0].object_ownership == "BucketOwnerEnforced"])
    error_message = "Both buckets must be BucketOwnerEnforced (ACLs disabled)."
  }

  assert {
    condition = alltrue([for e in aws_s3_bucket_server_side_encryption_configuration.this :
    one(e.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"])
    error_message = "Both buckets must use SSE-S3."
  }

  assert {
    condition     = alltrue([for b in aws_s3_bucket.this : !b.force_destroy])
    error_message = "No bucket may be force_destroy."
  }
}

run "buckets_deny_non_tls" {
  assert {
    condition = length(aws_s3_bucket_policy.this) == 2 && alltrue([for k, p in aws_s3_bucket_policy.this : anytrue([
      for s in jsondecode(p.policy).Statement :
      s.Effect == "Deny" && s.Principal == "*" && s.Action == "s3:*" &&
      try(s.Condition.Bool["aws:SecureTransport"], "") == "false" &&
      toset(s.Resource) == toset(["arn:aws:s3:::${local.buckets[k]}", "arn:aws:s3:::${local.buckets[k]}/*"])
    ])])
    error_message = "Each bucket policy must deny s3:* to everyone on the bucket and its objects when aws:SecureTransport is false."
  }

  assert {
    condition = alltrue([for p in aws_s3_bucket_policy.this :
    alltrue([for s in jsondecode(p.policy).Statement : s.Effect == "Deny"])])
    error_message = "The bucket policies may only deny (access is granted by IAM roles)."
  }
}

run "backups_expire_after_14_days" {
  assert {
    condition     = aws_s3_bucket_versioning.backups.versioning_configuration[0].status == "Enabled"
    error_message = "The backups bucket must be versioned."
  }

  assert {
    condition = anytrue([for r in aws_s3_bucket_lifecycle_configuration.backups.rule :
      r.status == "Enabled" && try(r.expiration[0].days, 0) == 14 &&
    try(r.noncurrent_version_expiration[0].noncurrent_days, 0) == 14])
    error_message = "Backups (current and noncurrent versions) must expire after 14 days."
  }

  assert {
    condition     = aws_s3_bucket_versioning.backups.bucket == aws_s3_bucket.this["backups"].id && aws_s3_bucket.this["backups"].bucket == "forexedge-backups-111122223333"
    error_message = "Versioning and expiry belong to the backups bucket."
  }
}
