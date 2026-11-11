# Variable validations: a wildcard repository, an unknown credit mode or a bad address never reaches a plan.
mock_provider "aws" {
  source = "./tests/mocks"
}

variables {
  alert_email = "alerts@example.com"
}

run "defaults_are_valid" {
  command = plan

  assert {
    condition     = var.region == "ap-south-1" && var.cpu_credits == "standard" && var.enable_termination_protection
    error_message = "Defaults changed: region ap-south-1, cpu_credits standard, termination protection on."
  }

  assert {
    condition     = var.instance_state == "running"
    error_message = "The host must be running by default."
  }
}

run "rejects_wildcard_repo" {
  command = plan
  variables {
    github_repo = "aakash1514/*"
  }
  expect_failures = [var.github_repo]
}

run "rejects_unknown_credit_mode" {
  command = plan
  variables {
    cpu_credits = "burst"
  }
  expect_failures = [var.cpu_credits]
}

run "rejects_unknown_instance_state" {
  command = plan
  variables {
    instance_state = "paused"
  }
  expect_failures = [var.instance_state]
}

run "rejects_terminated_instance_state" {
  command = plan
  variables {
    instance_state = "terminated"
  }
  expect_failures = [var.instance_state]
}

run "rejects_bad_email" {
  command = plan
  variables {
    alert_email = "not-an-address"
  }
  expect_failures = [var.alert_email]
}

run "rejects_small_root_volume" {
  command = plan
  variables {
    root_volume_gb = 8
  }
  expect_failures = [var.root_volume_gb]
}
