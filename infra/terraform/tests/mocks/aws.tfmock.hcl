# Fixed values for the mocked AWS provider (terraform test never calls AWS). Anything not listed here is
# a random string, so the tests compare only values the configuration builds itself.
mock_data "aws_caller_identity" {
  defaults = {
    account_id = "111122223333"
  }
}

mock_data "aws_ssm_parameter" {
  defaults = {
    insecure_value = "ami-0123456789abcdef0"
  }
}

# The instance ARN the deploy role's SendCommand statement must name
mock_resource "aws_instance" {
  defaults = {
    id  = "i-0123456789abcdef0"
    arn = "arn:aws:ec2:ap-south-1:111122223333:instance/i-0123456789abcdef0"
  }
}

# ARNs that other resources validate as ARNs (a random mock string fails the provider's validation)
mock_resource "aws_sns_topic" {
  defaults = {
    arn = "arn:aws:sns:ap-south-1:111122223333:forexedge-alerts"
  }
}

mock_resource "aws_iam_role" {
  defaults = {
    arn = "arn:aws:iam::111122223333:role/forexedge-mock"
  }
}
