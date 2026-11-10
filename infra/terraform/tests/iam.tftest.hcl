# IAM (Group C): the host role never deletes, the deploy role trusts main only and runs on this host only.
mock_provider "aws" {
  source = "./tests/mocks"
}

variables {
  alert_email = "alerts@example.com"
}

run "vm_role_never_deletes" {
  assert {
    condition = alltrue(flatten([for s in jsondecode(aws_iam_role_policy.ec2.policy).Statement : [
      for a in flatten([s.Action]) : a != "*" && a != "s3:*" && !startswith(a, "s3:Delete") && !startswith(a, "s3:Put") || a == "s3:PutObject"
    ]]))
    error_message = "The host role may not delete objects (no s3:Delete*, s3:*, or *) nor change bucket settings."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.ec2.policy).Statement : flatten([s.Action])])) == toset([
      "ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability",
      "s3:ListBucket", "s3:GetObject", "s3:PutObject",
    ])
    error_message = "The host role's inline policy must grant exactly ECR pull and S3 list/get/put."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.ec2.policy).Statement : flatten([s.Resource]) if startswith(flatten([s.Action])[0], "s3:")])) == toset([
      "arn:aws:s3:::forexedge-results-111122223333", "arn:aws:s3:::forexedge-backups-111122223333",
      "arn:aws:s3:::forexedge-results-111122223333/*", "arn:aws:s3:::forexedge-backups-111122223333/*",
    ])
    error_message = "The host role's S3 rights must cover the two buckets only."
  }

  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.ec2.policy).Statement :
    s.Resource != "*" || flatten([s.Action]) == ["ecr:GetAuthorizationToken"]])
    error_message = "Only ecr:GetAuthorizationToken may use Resource \"*\"."
  }

  assert {
    condition = toset([aws_iam_role_policy_attachment.ec2_ssm.policy_arn, aws_iam_role_policy_attachment.ec2_cloudwatch_agent.policy_arn]) == toset([
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore", "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"])
    error_message = "The host role's managed policies are SSM core and the CloudWatch agent only."
  }

  assert {
    condition     = jsondecode(aws_iam_role.ec2.assume_role_policy).Statement[0].Principal == { Service = "ec2.amazonaws.com" }
    error_message = "Only EC2 may assume the host role."
  }
}

run "oidc_trusts_main_branch_only" {
  assert {
    condition     = length(jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement) == 1
    error_message = "The deploy role must have exactly one trust statement."
  }

  assert {
    condition = jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Condition == {
      StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:aakash1514/algo_trading_forex:ref:refs/heads/main"
      }
    }
    error_message = "The trust must be StringEquals on aud sts.amazonaws.com and sub repo:aakash1514/algo_trading_forex:ref:refs/heads/main, nothing else."
  }

  assert {
    condition     = !strcontains(aws_iam_role.github_deploy.assume_role_policy, "*") && !strcontains(aws_iam_role.github_deploy.assume_role_policy, "?")
    error_message = "The trust policy may not contain a wildcard."
  }

  assert {
    condition = (jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Principal == { Federated = aws_iam_openid_connect_provider.github.arn } &&
    jsondecode(aws_iam_role.github_deploy.assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity")
    error_message = "Only GitHub's OIDC provider may assume the deploy role, with a web identity token."
  }

  assert {
    condition     = aws_iam_openid_connect_provider.github.url == "https://token.actions.githubusercontent.com" && toset(aws_iam_openid_connect_provider.github.client_id_list) == toset(["sts.amazonaws.com"])
    error_message = "The OIDC provider must be GitHub's, for the audience sts.amazonaws.com."
  }
}

run "deploy_role_rights" {
  assert {
    condition = flatten([for s in jsondecode(aws_iam_role_policy.github_deploy.policy).Statement : s.Resource if flatten([s.Action]) == ["ssm:SendCommand"]]) == [
      "arn:aws:ec2:ap-south-1:111122223333:instance/i-0123456789abcdef0",
      "arn:aws:ssm:ap-south-1::document/AWS-RunShellScript",
    ] && aws_instance.app.arn == "arn:aws:ec2:ap-south-1:111122223333:instance/i-0123456789abcdef0"
    error_message = "ssm:SendCommand must be limited to this instance's ARN and the AWS-RunShellScript document."
  }

  assert {
    condition = sort(flatten([for s in jsondecode(aws_iam_role_policy.github_deploy.policy).Statement : flatten([s.Action])])) == sort([
      "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ssm:SendCommand", "ssm:GetCommandInvocation",
    ])
    error_message = "The deploy role must grant exactly ECR push, SendCommand and GetCommandInvocation."
  }

  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.github_deploy.policy).Statement :
      s.Effect == "Allow" && (s.Resource != "*" || contains([["ecr:GetAuthorizationToken"], ["ssm:GetCommandInvocation"]], flatten([s.Action])))
    ])
    error_message = "Only GetAuthorizationToken and GetCommandInvocation (no resource-level permissions) may use Resource \"*\"."
  }

  assert {
    condition = flatten([for s in jsondecode(aws_iam_role_policy.github_deploy.policy).Statement : s.Resource if contains(flatten([s.Action]), "ecr:PutImage")]) == [
      for i in sort(["auth-service", "domain-service", "frontend", "market-service", "ml-service", "ops", "order-service", "replay-service", "research-agent", "ws-gateway"]) :
      "arn:aws:ecr:ap-south-1:111122223333:repository/forexedge/${i}"
    ]
    error_message = "ECR push must be limited to the ten forexedge repositories."
  }
}
