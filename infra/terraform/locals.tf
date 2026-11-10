data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # One ECR repository per image in infra/docker-compose.prod.yml, under the prefix forexedge/, so
  # IMAGE_REGISTRY = <account>.dkr.ecr.<region>.amazonaws.com/forexedge
  images = toset([
    "auth-service",
    "market-service",
    "domain-service",
    "order-service",
    "ws-gateway",
    "replay-service",
    "ml-service",
    "research-agent",
    "frontend",
    "ops",
  ])

  # Built from the names (not read from the repository resources) so the IAM policies are exact strings
  # before apply, and testable under mock_provider
  ecr_repository_arns = sort([for image in local.images : "arn:aws:ecr:${var.region}:${local.account_id}:repository/forexedge/${image}"])

  # Bucket names are global: the account id keeps them unique
  results_bucket = "forexedge-results-${local.account_id}"
  backups_bucket = "forexedge-backups-${local.account_id}"

  availability_zone = "${var.region}a"
}
