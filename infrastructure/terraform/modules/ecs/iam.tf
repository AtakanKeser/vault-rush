# IAM: one execution role (agent-side: pull image, ship logs, fetch secrets) and one task
# role per service scoped to exactly the resources that service touches.

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Confused-deputy protection: only tasks from this account/cluster may assume the roles.
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# ---------------------------------------------------------------------------------------
# Execution role
# ---------------------------------------------------------------------------------------

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  statement {
    sid       = "ReadSecrets"
    actions   = ["ssm:GetParameters", "ssm:GetParameter", "secretsmanager:GetSecretValue"]
    resources = values(var.secrets)
  }

  # SecureString parameters are encrypted with the AWS-managed aws/ssm key.
  statement {
    sid       = "DecryptViaSSM"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com", "secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

# ---------------------------------------------------------------------------------------
# Shared statement: DynamoDB single table (+ GSI1)
# ---------------------------------------------------------------------------------------

data "aws_iam_policy_document" "dynamodb_table" {
  statement {
    sid = "DynamoDBTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:TransactGetItems",
      "dynamodb:TransactWriteItems",
      "dynamodb:DescribeTable",
    ]
    resources = [
      var.dynamodb_table_arn,
      "${var.dynamodb_table_arn}/index/*",
    ]
  }
}

# ---------------------------------------------------------------------------------------
# API task role: read/write the table, publish events. No Scan (nothing in the API needs
# it, and it is the expensive footgun on a single table). Redis: network access only.
# ---------------------------------------------------------------------------------------

data "aws_iam_policy_document" "api_task" {
  source_policy_documents = [data.aws_iam_policy_document.dynamodb_table.json]

  statement {
    sid = "SQSPublish"
    actions = [
      "sqs:SendMessage",
      "sqs:SendMessageBatch",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [var.sqs_queue_arn]
  }
}

resource "aws_iam_role" "api_task" {
  name               = "${var.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = var.tags
}

resource "aws_iam_role_policy" "api_task" {
  name   = "api-access"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

# ---------------------------------------------------------------------------------------
# Worker task role: consume the queue, re-enqueue, read the DLQ for replays. Scan is
# granted for the scheduled reconciliation job (rebuild leaderboard from RUN# items).
# ---------------------------------------------------------------------------------------

data "aws_iam_policy_document" "worker_task" {
  source_policy_documents = [data.aws_iam_policy_document.dynamodb_table.json]

  statement {
    sid       = "DynamoDBScanForReconciliation"
    actions   = ["dynamodb:Scan"]
    resources = [var.dynamodb_table_arn, "${var.dynamodb_table_arn}/index/*"]
  }

  statement {
    sid = "SQSConsume"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:DeleteMessageBatch",
      "sqs:ChangeMessageVisibility",
      "sqs:ChangeMessageVisibilityBatch",
      "sqs:SendMessage",
      "sqs:SendMessageBatch",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [var.sqs_queue_arn]
  }

  statement {
    sid = "SQSDeadLetterReplay"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:DeleteMessageBatch",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [var.sqs_dlq_arn]
  }
}

resource "aws_iam_role" "worker_task" {
  name               = "${var.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = var.tags
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "worker-access"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task.json
}
