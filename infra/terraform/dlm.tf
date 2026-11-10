# Daily snapshot of the root volume (it holds the database), the last 7 kept. Snapshots of a running
# database are crash-consistent: Postgres replays its WAL on restore. A snapshot outlives this policy:
# deleting the policy (or terraform destroy) leaves the existing snapshots (docs/DEPLOY.md, destroy).
#
# The role is DLM's own, limited to what this policy does (instead of AWSDataLifecycleManagerServiceRole):
# snapshot volumes tagged forexedge:snapshot=daily, tag the snapshots it creates, delete only snapshots it
# tagged forexedge:dlm=daily.
resource "aws_iam_role" "dlm" {
  name        = "forexedge-dlm"
  description = "Data Lifecycle Manager: daily snapshots of the ForexEdge root volume"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "dlm" {
  name = "forexedge-dlm"
  role = aws_iam_role.dlm.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Describe* has no resource-level permissions
        Sid      = "Describe"
        Effect   = "Allow"
        Action   = ["ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeSnapshots"]
        Resource = "*"
      },
      {
        Sid       = "SnapshotTaggedVolume"
        Effect    = "Allow"
        Action    = "ec2:CreateSnapshot"
        Resource  = "arn:aws:ec2:${var.region}:${local.account_id}:volume/*"
        Condition = { StringEquals = { "aws:ResourceTag/forexedge:snapshot" = "daily" } }
      },
      {
        Sid      = "CreateSnapshotObject"
        Effect   = "Allow"
        Action   = "ec2:CreateSnapshot"
        Resource = "arn:aws:ec2:${var.region}::snapshot/*"
      },
      {
        Sid       = "TagOnCreate"
        Effect    = "Allow"
        Action    = "ec2:CreateTags"
        Resource  = "arn:aws:ec2:${var.region}::snapshot/*"
        Condition = { StringEquals = { "ec2:CreateAction" = "CreateSnapshot" } }
      },
      {
        Sid       = "DeleteOwnSnapshots"
        Effect    = "Allow"
        Action    = "ec2:DeleteSnapshot"
        Resource  = "arn:aws:ec2:${var.region}::snapshot/*"
        Condition = { StringEquals = { "aws:ResourceTag/forexedge:dlm" = "daily" } }
      },
    ]
  })
}

# DLM accepts only letters, digits, spaces, _ and - in the description
resource "aws_dlm_lifecycle_policy" "root_daily" {
  description        = "ForexEdge root volume - daily - keep 7"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    policy_type    = "EBS_SNAPSHOT_MANAGEMENT"
    resource_types = ["VOLUME"]
    target_tags    = { "forexedge:snapshot" = "daily" }

    schedule {
      name = "daily-keep-7"

      # 20:30 UTC = 02:00 IST
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["20:30"]
      }

      retain_rule {
        count = 7
      }

      tags_to_add = { "forexedge:dlm" = "daily" }
      copy_tags   = false
    }
  }
}
