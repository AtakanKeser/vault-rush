# Events queue consumed by the worker binary, with a dead-letter queue.
#
# The API's telemetry pipeline publishes run/reward/purchase events here (after the
# in-process worker pool has drained them from the channel). A message that fails
# processing 5 times moves to the DLQ; docs/operations.md describes replaying it.

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.queue_name}-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum: gives time to investigate
  sqs_managed_sse_enabled   = true

  tags = merge(var.tags, { Name = "${var.queue_name}-dlq" })
}

resource "aws_sqs_queue" "events" {
  name = var.queue_name

  # Long polling: the worker's ReceiveMessage blocks up to 20s instead of spinning.
  receive_wait_time_seconds = 20

  # Must exceed the worker's per-message processing budget; a message becomes visible
  # again (and counts one receive toward maxReceiveCount) if not deleted within it.
  visibility_timeout_seconds = 60

  message_retention_seconds = 345600 # 4 days
  sqs_managed_sse_enabled   = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })

  tags = merge(var.tags, { Name = var.queue_name })
}

# Only the events queue may use this DLQ as a dead-letter target.
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.events.arn]
  })
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.name}-events-dlq-not-empty"
  alarm_description   = "Messages landed in the events DLQ: the worker failed to process them 5 times."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name}-events-oldest-message-age"
  alarm_description   = "Events are waiting more than 10 minutes: the worker is down or under-scaled."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.events.name
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions

  tags = var.tags
}
