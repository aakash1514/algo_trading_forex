# Outputs (Group E): what docs/DEPLOY.md copies into infra/.env.prod and the registrar.
mock_provider "aws" {
  source = "./tests/mocks"
}

variables {
  alert_email = "alerts@example.com"
}

run "outputs" {
  assert {
    condition     = output.image_registry == "111122223333.dkr.ecr.ap-south-1.amazonaws.com/forexedge"
    error_message = "image_registry must be the account's ECR host with the forexedge/ prefix (IMAGE_REGISTRY)."
  }

  assert {
    condition     = output.results_bucket == "forexedge-results-111122223333" && output.backups_bucket == "forexedge-backups-111122223333"
    error_message = "Bucket outputs must name the two buckets."
  }

  assert {
    condition     = keys(output.dns_records) == ["forexedge.tech", "www.forexedge.tech"] && alltrue([for ip in values(output.dns_records) : ip == aws_eip.app.public_ip])
    error_message = "dns_records must point the apex and www at the Elastic IP."
  }

  assert {
    condition     = length(output.ecr_repository_urls) == 10 && output.instance_id == "i-0123456789abcdef0"
    error_message = "Outputs must list the ten repositories and the instance."
  }
}
