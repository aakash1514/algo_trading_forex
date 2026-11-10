# The instance (Group C): IMDSv2, encrypted root, credit mode, termination protection.
mock_provider "aws" {
  source = "./tests/mocks"
}

variables {
  alert_email = "alerts@example.com"
}

run "imdsv2_required" {
  assert {
    condition     = aws_instance.app.metadata_options[0].http_tokens == "required" && aws_instance.app.metadata_options[0].http_endpoint == "enabled"
    error_message = "Instance metadata must require IMDSv2 tokens."
  }

  assert {
    condition     = aws_instance.app.metadata_options[0].http_put_response_hop_limit == 2
    error_message = "The IMDS hop limit must be exactly 2 (containers need one hop more than the host, nothing further)."
  }

  assert {
    condition     = aws_instance.app.metadata_options[0].http_protocol_ipv6 == "disabled"
    error_message = "The IPv6 metadata endpoint must stay off (imds-guard.sh filters IPv4 only)."
  }
}

run "root_volume_encrypted" {
  assert {
    condition     = aws_instance.app.root_block_device[0].encrypted && aws_instance.app.root_block_device[0].volume_type == "gp3"
    error_message = "The root volume must be encrypted gp3."
  }

  assert {
    condition     = aws_instance.app.root_block_device[0].volume_size == 40
    error_message = "The root volume must follow root_volume_gb (default 40)."
  }

  assert {
    condition     = aws_ebs_encryption_by_default.this.enabled
    error_message = "EBS encryption by default must be on for the account."
  }
}

run "cpu_credits_standard_by_default" {
  assert {
    condition     = aws_instance.app.credit_specification[0].cpu_credits == "standard"
    error_message = "cpu_credits must be standard by default (no surplus charges)."
  }
}

run "cpu_credits_follow_variable" {
  variables {
    cpu_credits = "unlimited"
  }

  assert {
    condition     = aws_instance.app.credit_specification[0].cpu_credits == "unlimited"
    error_message = "cpu_credits must follow the variable."
  }
}

run "termination_protection" {
  assert {
    condition     = aws_instance.app.disable_api_termination
    error_message = "Termination protection must be on by default."
  }

  assert {
    condition     = !aws_instance.app.monitoring
    error_message = "Detailed monitoring must be off."
  }

  assert {
    condition     = aws_instance.app.ami == "ami-0123456789abcdef0" && aws_instance.app.instance_type == "t3.medium"
    error_message = "The AMI comes from Canonical's SSM parameter, the type from instance_type."
  }
}

run "termination_protection_off_for_destroy" {
  variables {
    enable_termination_protection = false
  }

  assert {
    condition     = !aws_instance.app.disable_api_termination
    error_message = "Termination protection must follow the variable."
  }
}
