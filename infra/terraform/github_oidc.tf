# GitHub Actions deploys (Phase 4; unused until then) through OIDC: no access keys anywhere. The role
# trusts exactly one subject, this repository's main branch. A workflow that uses a GitHub Environment
# sends repo:<repo>:environment:<name> instead and is refused until this trust is changed on purpose.
locals {
  github_oidc_host      = "token.actions.githubusercontent.com"
  github_deploy_subject = "repo:${var.github_repo}:ref:refs/heads/main"
  run_shell_document    = "arn:aws:ssm:${var.region}::document/AWS-RunShellScript"
}

# GitHub's OIDC provider already exists in the account and is shared with other projects (an account has
# one provider per URL). This stack only reads it, so a destroy can never delete it. The plan fails if the
# provider doesn't accept the audience the trust below requires.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://${local.github_oidc_host}"

  lifecycle {
    postcondition {
      condition     = contains(self.client_id_list, "sts.amazonaws.com")
      error_message = "GitHub's OIDC provider in this account must list the audience sts.amazonaws.com."
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "forexedge-github-deploy"
  description          = "GitHub Actions on ${var.github_repo} main: push images to ECR, run the deploy on the host"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.github_oidc_host}:aud" = "sts.amazonaws.com"
          "${local.github_oidc_host}:sub" = local.github_deploy_subject
        }
      }
    }]
  })
}

# Push only: no pull actions. If Phase 4 uses the registry as a build cache (buildx --cache-from), it will
# need ecr:BatchGetImage and ecr:GetDownloadUrlForLayer on the same repositories, added then on purpose.
resource "aws_iam_role_policy" "github_deploy" {
  name = "forexedge-github-deploy"
  role = aws_iam_role.github_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        Resource = local.ecr_repository_arns
      },
      {
        # SendCommand authorizes both the target and the document: this instance, AWS-RunShellScript only
        Sid      = "RunOnInstance"
        Effect   = "Allow"
        Action   = "ssm:SendCommand"
        Resource = [aws_instance.app.arn, local.run_shell_document]
      },
      {
        # GetCommandInvocation has no resource-level permissions; it only reads a command's output
        Sid      = "ReadCommandResult"
        Effect   = "Allow"
        Action   = "ssm:GetCommandInvocation"
        Resource = "*"
      },
    ]
  })
}
