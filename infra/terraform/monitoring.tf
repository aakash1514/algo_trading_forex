# Alarms to one SNS topic, delivered by email (the subscription stays "pending" until the link in AWS's
# email is clicked). The topic is not KMS-encrypted: CloudWatch alarms cannot publish to a topic under the
# AWS-managed SNS key.
resource "aws_sns_topic" "alerts" {
  name = "forexedge-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  instance_dimensions = { InstanceId = aws_instance.app.id }

  # CWAgent metrics carry exactly the dimensions the agent config in infra/vm/setup.sh produces:
  # omit_hostname (no "host"), drop_device (no "device"), append_dimensions InstanceId only.
  # Basic monitoring publishes AWS/EC2 metrics every 5 minutes (status checks every minute).
  alarms = {
    cpu-high = {
      description = "CPU above 80% for 15 minutes"
      namespace   = "AWS/EC2"
      metric      = "CPUUtilization"
      statistic   = "Average"
      operator    = "GreaterThanThreshold"
      threshold   = 80
      period      = 300
      periods     = 3
      dimensions  = local.instance_dimensions
    }
    # A t3 in standard mode starts with no credits: this alarm firing in the first hours after a launch
    # is expected (docs/DEPLOY.md)
    cpu-credits-low = {
      description = "CPU credit balance below 30 (standard mode slows to the 20% baseline at 0)"
      namespace   = "AWS/EC2"
      metric      = "CPUCreditBalance"
      statistic   = "Minimum"
      operator    = "LessThanThreshold"
      threshold   = 30
      period      = 300
      periods     = 1
      dimensions  = local.instance_dimensions
    }
    status-check-failed = {
      description = "Instance or system status check failing for 2 minutes"
      namespace   = "AWS/EC2"
      metric      = "StatusCheckFailed"
      statistic   = "Maximum"
      operator    = "GreaterThanOrEqualToThreshold"
      threshold   = 1
      period      = 60
      periods     = 2
      dimensions  = local.instance_dimensions
    }
    memory-high = {
      description = "Memory used above 90% for 3 minutes"
      namespace   = "CWAgent"
      metric      = "mem_used_percent"
      statistic   = "Average"
      operator    = "GreaterThanThreshold"
      threshold   = 90
      period      = 60
      periods     = 3
      dimensions  = local.instance_dimensions
    }
    disk-high = {
      description = "Root filesystem above 80% used"
      namespace   = "CWAgent"
      metric      = "disk_used_percent"
      statistic   = "Average"
      operator    = "GreaterThanThreshold"
      threshold   = 80
      period      = 300
      periods     = 1
      dimensions  = merge(local.instance_dimensions, { path = "/", fstype = "ext4" })
    }
  }
}

# Missing data leaves an alarm in INSUFFICIENT_DATA (not ALARM): the agent's alarms stay quiet until
# setup.sh has installed it, and a stopped instance doesn't page
resource "aws_cloudwatch_metric_alarm" "this" {
  for_each = local.alarms

  alarm_name          = "forexedge-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  comparison_operator = each.value.operator
  threshold           = each.value.threshold
  period              = each.value.period
  evaluation_periods  = each.value.periods
  dimensions          = each.value.dimensions
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
