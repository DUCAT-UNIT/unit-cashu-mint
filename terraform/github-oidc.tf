# GitHub OIDC Provider for AWS
# Allows GitHub Actions to authenticate to AWS without storing credentials
#
# This creates a trust relationship between GitHub and AWS so that
# workflows in your repository can assume an IAM role.

# GitHub OIDC Provider
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"] # GitHub's thumbprint (AWS ignores this for GitHub)

  tags = {
    Name = "github-oidc-provider"
  }
}

# IAM Role for GitHub Actions
resource "aws_iam_role" "github_actions" {
  name = "ducat-mint-github-actions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            # Only allow from your specific repository
            "token.actions.githubusercontent.com:sub" = "repo:${var.github_org}/${var.github_repo}:*"
          }
        }
      }
    ]
  })

  tags = {
    Name = "ducat-mint-github-actions"
  }
}

# Policy for GitHub Actions role
resource "aws_iam_role_policy" "github_actions" {
  name = "github-actions-deploy"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # EC2 access for deployment
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus"
        ]
        Resource = "*"
      },
      # SSM for remote commands (instead of SSH)
      {
        Effect = "Allow"
        Action = [
          "ssm:SendCommand",
          "ssm:GetCommandInvocation",
          "ssm:StartSession",
          "ssm:TerminateSession"
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*",
          "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.mint.id}",
          "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript"
        ]
      },
      # S3 for EIF storage
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.artifacts.arn,
          "${aws_s3_bucket.artifacts.arn}/*"
        ]
      },
      # KMS policy updates
      {
        Effect = "Allow"
        Action = [
          "kms:GetKeyPolicy",
          "kms:PutKeyPolicy"
        ]
        Resource = aws_kms_key.enclave_secrets.arn
      },
      # ECR for Docker images (optional)
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ]
        Resource = "*"
      }
    ]
  })
}

# S3 bucket for build artifacts (EIF files, etc.)
resource "aws_s3_bucket" "artifacts" {
  bucket = "ducat-mint-artifacts-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "ducat-mint-artifacts"
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.enclave_secrets.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Variables for GitHub
variable "github_org" {
  description = "GitHub organization or username"
  type        = string
  default     = "DUCAT-UNIT"
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "unit-cashu-mint"
}

# Outputs
output "github_actions_role_arn" {
  description = "ARN of the IAM role for GitHub Actions"
  value       = aws_iam_role.github_actions.arn
}

output "artifacts_bucket" {
  description = "S3 bucket for build artifacts"
  value       = aws_s3_bucket.artifacts.bucket
}
