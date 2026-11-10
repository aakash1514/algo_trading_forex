# The host's role (forexedge-ec2): Session Manager, the CloudWatch agent, ECR pull on the ten repositories,
# and read/write (never delete) on the two buckets. ws-gateway gets these credentials through instance
# metadata (ec2-role-credentials.ts); only ws-gateway's container may reach it (infra/vm/imds-guard.sh).
resource "aws_iam_role" "ec2" {
  name        = "forexedge-ec2"
  description = "ForexEdge host: SSM, CloudWatch agent, ECR pull, results and backups buckets"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "ec2_cloudwatch_agent" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy" "ec2" {
  name = "forexedge-ec2"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # GetAuthorizationToken has no resource-level permissions: "*" is the only valid resource
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid      = "EcrPull"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = local.ecr_repository_arns
      },
      {
        # ws-gateway's startup and readiness check that the results bucket exists (HeadBucket)
        Sid      = "ListBuckets"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = ["arn:aws:s3:::${local.results_bucket}", "arn:aws:s3:::${local.backups_bucket}"]
      },
      {
        Sid      = "ReadWriteObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = ["arn:aws:s3:::${local.results_bucket}/*", "arn:aws:s3:::${local.backups_bucket}/*"]
      },
    ]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name = "forexedge-ec2"
  role = aws_iam_role.ec2.name
}
