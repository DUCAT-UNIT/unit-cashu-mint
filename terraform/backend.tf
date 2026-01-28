# Terraform Backend Configuration
# Stores state in S3 with DynamoDB locking for team collaboration
#
# IMPORTANT: Run this AFTER the initial apply that creates the bucket
# 1. First run: terraform init && terraform apply (creates bucket)
# 2. Uncomment backend config below
# 3. Run: terraform init -migrate-state

# Uncomment after first apply:
# terraform {
#   backend "s3" {
#     bucket         = "ducat-mint-terraform-state-160885263687"
#     key            = "enclave/terraform.tfstate"
#     region         = "us-east-1"
#     encrypt        = true
#     dynamodb_table = "ducat-mint-terraform-locks"
#   }
# }

# S3 bucket for Terraform state
resource "aws_s3_bucket" "terraform_state" {
  bucket = "ducat-mint-terraform-state-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name = "ducat-mint-terraform-state"
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# DynamoDB table for state locking
resource "aws_dynamodb_table" "terraform_locks" {
  name         = "ducat-mint-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name = "ducat-mint-terraform-locks"
  }
}

output "terraform_state_bucket" {
  description = "S3 bucket for Terraform state"
  value       = aws_s3_bucket.terraform_state.bucket
}
