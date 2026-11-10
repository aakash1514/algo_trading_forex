# Identifiers only: no output is a secret (state and outputs are plain text).
output "instance_id" {
  description = "The host's instance id (Session Manager: aws ssm start-session --target <id>)."
  value       = aws_instance.app.id
}

output "elastic_ip" {
  description = "The host's public IPv4: the A records of the domain and www point here."
  value       = aws_eip.app.public_ip
}

output "dns_records" {
  description = "The A records to create at the registrar before the first docker compose up (Let's Encrypt)."
  value = {
    (var.domain)          = aws_eip.app.public_ip
    ("www.${var.domain}") = aws_eip.app.public_ip
  }
}

output "image_registry" {
  description = "IMAGE_REGISTRY for infra/.env.prod."
  value       = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com/forexedge"
}

output "ecr_repository_urls" {
  description = "Repository URL per image."
  value       = { for image, repo in aws_ecr_repository.this : image => repo.repository_url }
}

output "results_bucket" {
  description = "S3_BUCKET for infra/.env.prod (backtest results)."
  value       = aws_s3_bucket.this["results"].bucket
}

output "backups_bucket" {
  description = "Bucket for database backups (every version expires after 14 days)."
  value       = aws_s3_bucket.this["backups"].bucket
}

output "deploy_role_arn" {
  description = "Role GitHub Actions assumes from main (Phase 4)."
  value       = aws_iam_role.github_deploy.arn
}

output "sns_topic_arn" {
  description = "Alarm topic; confirm the email subscription after the first apply."
  value       = aws_sns_topic.alerts.arn
}
