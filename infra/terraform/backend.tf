# State in S3, locked by a lock file next to it (use_lockfile; no DynamoDB table). The bucket is created
# by hand before the first init (docs/DEPLOY.md section 7) and named at init time:
#   terraform init -backend-config="bucket=<state bucket>"
# State is plain JSON: no secret may ever reach a resource argument, variable or output.
terraform {
  backend "s3" {
    key          = "forexedge/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}
