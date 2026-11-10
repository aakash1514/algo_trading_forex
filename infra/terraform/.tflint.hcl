# tflint v0.65.0 (image pinned by digest in check.sh) with the AWS ruleset pinned below. deep_check is off:
# it calls AWS, and these checks never do.
config {
  call_module_type = "none"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled    = true
  version    = "0.50.0"
  source     = "github.com/terraform-linters/tflint-ruleset-aws"
  deep_check = false
}
