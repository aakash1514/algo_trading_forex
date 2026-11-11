# The single host: Ubuntu 24.04 LTS (x86_64) from Canonical's public SSM parameter. The AMI is read once:
# ignore_changes keeps a newer image from replacing the instance (and the database on its root volume).
# associate_public_ip_address is false at creation, but AWS reports true once the Elastic IP is associated
# and the attribute forces replacement: ignored too, or every plan after the first apply rebuilds the host
# (check.sh refuses an ignore_changes without both).
# A deliberate rebuild is `terraform apply -replace=aws_instance.app` after a backup (docs/DEPLOY.md).

# Account-wide: every new EBS volume and snapshot copy in this region is encrypted
resource "aws_ebs_encryption_by_default" "this" {
  enabled = true
}

data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.ubuntu_ami.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.web.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  associate_public_ip_address = false
  disable_api_termination     = var.enable_termination_protection
  monitoring                  = false

  # standard: a t3 that runs out of credits slows to its baseline instead of billing surplus credits
  credit_specification {
    cpu_credits = var.cpu_credits
  }

  # IMDSv2 only. Hop limit 2: the token is the answer to a PUT, sent with IP TTL = hop limit, and a
  # container's packets cross the Docker bridge (one routed hop), so with 1 the answer never reaches
  # ws-gateway. 2 lets containers in and nothing further; imds-guard.sh then admits ws-gateway only.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    http_protocol_ipv6          = "disabled"
    instance_metadata_tags      = "disabled"
  }

  # The database lives here. forexedge:snapshot selects it for the daily DLM snapshots (dlm.tf).
  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true

    tags = {
      Name                 = "forexedge-root"
      "forexedge:snapshot" = "daily"
    }
  }

  tags = { Name = "forexedge" }

  lifecycle {
    ignore_changes = [ami, associate_public_ip_address]
  }

  depends_on = [aws_ebs_encryption_by_default.this]
}

resource "aws_eip" "app" {
  domain = "vpc"

  tags = { Name = "forexedge" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_eip_association" "app" {
  instance_id   = aws_instance.app.id
  allocation_id = aws_eip.app.id
}
