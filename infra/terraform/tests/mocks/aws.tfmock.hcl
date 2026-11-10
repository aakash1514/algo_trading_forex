# Fixed values for the mocked AWS provider (terraform test never calls AWS). Anything not listed here is
# a random string, so the tests compare only values the configuration builds itself.
mock_data "aws_caller_identity" {
  defaults = {
    account_id = "111122223333"
  }
}
