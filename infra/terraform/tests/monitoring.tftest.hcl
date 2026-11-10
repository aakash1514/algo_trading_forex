# Alarms and snapshots (Group D).
mock_provider "aws" {
  source = "./tests/mocks"
}

variables {
  alert_email = "alerts@example.com"
}

run "alarms" {
  assert {
    condition     = aws_sns_topic_subscription.alert_email.protocol == "email" && aws_sns_topic_subscription.alert_email.endpoint == "alerts@example.com"
    error_message = "Alarms are delivered by email to alert_email."
  }

  assert {
    condition = alltrue([for a in aws_cloudwatch_metric_alarm.this :
    a.alarm_actions == toset([aws_sns_topic.alerts.arn]) && a.ok_actions == toset([aws_sns_topic.alerts.arn])])
    error_message = "Every alarm must notify the topic on ALARM and OK."
  }

  assert {
    condition = { for k, a in aws_cloudwatch_metric_alarm.this : k => "${a.namespace} ${a.metric_name} ${a.statistic} ${a.comparison_operator} ${a.threshold} ${a.period}x${a.evaluation_periods}" } == {
      cpu-high            = "AWS/EC2 CPUUtilization Average GreaterThanThreshold 80 300x3"
      cpu-credits-low     = "AWS/EC2 CPUCreditBalance Minimum LessThanThreshold 30 300x1"
      status-check-failed = "AWS/EC2 StatusCheckFailed Maximum GreaterThanOrEqualToThreshold 1 60x2"
      memory-high         = "CWAgent mem_used_percent Average GreaterThanThreshold 90 60x3"
      disk-high           = "CWAgent disk_used_percent Average GreaterThanThreshold 80 300x1"
    }
    error_message = "The five alarms: CPU > 80% for 15 min, credits < 30, status check, memory > 90%, disk > 80%."
  }

  # Must match the agent config in infra/vm/setup.sh (omit_hostname, drop_device, append_dimensions)
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.this["memory-high"].dimensions == tomap({ InstanceId = aws_instance.app.id }) &&
      aws_cloudwatch_metric_alarm.this["disk-high"].dimensions == tomap({ InstanceId = aws_instance.app.id, path = "/", fstype = "ext4" }) &&
      alltrue([for k in ["cpu-high", "cpu-credits-low", "status-check-failed"] : aws_cloudwatch_metric_alarm.this[k].dimensions == tomap({ InstanceId = aws_instance.app.id })])
    )
    error_message = "Alarm dimensions must be exactly what the CloudWatch agent and EC2 publish for this instance."
  }
}

run "daily_snapshots" {
  assert {
    condition     = aws_dlm_lifecycle_policy.root_daily.policy_details[0].target_tags == tomap({ "forexedge:snapshot" = "daily" }) && aws_instance.app.root_block_device[0].tags["forexedge:snapshot"] == "daily"
    error_message = "DLM must target the root volume's forexedge:snapshot=daily tag."
  }

  assert {
    condition = (aws_dlm_lifecycle_policy.root_daily.policy_details[0].schedule[0].retain_rule[0].count == 7 &&
      aws_dlm_lifecycle_policy.root_daily.policy_details[0].schedule[0].create_rule[0].interval == 24 &&
    aws_dlm_lifecycle_policy.root_daily.state == "ENABLED")
    error_message = "One snapshot a day, the last 7 kept."
  }

  assert {
    condition     = aws_dlm_lifecycle_policy.root_daily.execution_role_arn == aws_iam_role.dlm.arn && jsondecode(aws_iam_role.dlm.assume_role_policy).Statement[0].Principal == { Service = "dlm.amazonaws.com" }
    error_message = "DLM runs with its own role."
  }

  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.dlm.policy).Statement :
    !contains(flatten([s.Action]), "ec2:DeleteSnapshot") || try(s.Condition.StringEquals["aws:ResourceTag/forexedge:dlm"], "") == "daily"])
    error_message = "The DLM role may delete only snapshots it tagged forexedge:dlm=daily."
  }

  assert {
    condition     = aws_dlm_lifecycle_policy.root_daily.policy_details[0].schedule[0].tags_to_add == tomap({ "forexedge:dlm" = "daily" })
    error_message = "DLM must tag its snapshots forexedge:dlm=daily (the delete condition depends on it)."
  }
}
