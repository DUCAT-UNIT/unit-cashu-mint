# Terraform Configuration for Ducat Cashu Mint on AWS Nitro Enclave
#
# This configuration creates:
# - VPC with public subnet
# - EC2 instance with Nitro Enclave support
# - KMS key with attestation-gated policy
# - IAM roles for enclave access
# - ACM certificate for TLS
# - Security groups

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state configuration (recommended for production)
  # backend "s3" {
  #   bucket = "ducat-terraform-state"
  #   key    = "mint-enclave/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "ducat-mint"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# =============================================================================
# Variables
# =============================================================================

variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "prod"
}

variable "domain_name" {
  description = "Domain name for the mint (e.g., mint.yourdomain.tld)"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type (must support Nitro Enclaves)"
  type        = string
  default     = "m5.xlarge"
}

variable "enclave_memory_mib" {
  description = "Memory allocation for enclave in MiB"
  type        = number
  default     = 4096
}

variable "enclave_cpu_count" {
  description = "CPU cores allocated to enclave"
  type        = number
  default     = 2
}

variable "db_password" {
  description = "PostgreSQL password for mint user"
  type        = string
  sensitive   = true
}

variable "admin_cidr_blocks" {
  description = "CIDR blocks allowed for SSH access"
  type        = list(string)
  default     = []
}

variable "key_pair_name" {
  description = "EC2 key pair name for SSH access"
  type        = string
}

# =============================================================================
# Data Sources
# =============================================================================

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

# Amazon Linux 2023 AMI
data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# =============================================================================
# VPC Configuration
# =============================================================================

resource "aws_vpc" "mint" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "ducat-mint-vpc"
  }
}

resource "aws_internet_gateway" "mint" {
  vpc_id = aws_vpc.mint.id

  tags = {
    Name = "ducat-mint-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.mint.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "ducat-mint-public-subnet"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.mint.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.mint.id
  }

  tags = {
    Name = "ducat-mint-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# =============================================================================
# Security Groups
# =============================================================================

resource "aws_security_group" "mint" {
  name        = "ducat-mint-sg"
  description = "Security group for Ducat mint enclave"
  vpc_id      = aws_vpc.mint.id

  # HTTPS inbound
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Health check
  ingress {
    description = "Health check"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # SSH (restricted)
  dynamic "ingress" {
    for_each = length(var.admin_cidr_blocks) > 0 ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.admin_cidr_blocks
    }
  }

  # All outbound
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "ducat-mint-sg"
  }
}

# =============================================================================
# KMS Key for Enclave Secrets
# =============================================================================

resource "aws_kms_key" "enclave_secrets" {
  description             = "KMS key for Ducat mint enclave secrets"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  # Policy is defined separately to support attestation conditions
  policy = data.aws_iam_policy_document.kms_policy.json

  tags = {
    Name = "ducat-mint-enclave-secrets"
  }
}

resource "aws_kms_alias" "enclave_secrets" {
  name          = "alias/ducat-mint-enclave"
  target_key_id = aws_kms_key.enclave_secrets.key_id
}

data "aws_iam_policy_document" "kms_policy" {
  # Allow account root full access
  statement {
    sid    = "AllowRootAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  # Allow enclave role to decrypt with attestation
  statement {
    sid    = "AllowEnclaveDecrypt"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.enclave.arn]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]

    resources = ["*"]

    # Attestation condition - PCR0 must match enclave image hash
    # Update this value after building the EIF
    condition {
      test     = "StringEqualsIgnoreCase"
      variable = "kms:RecipientAttestation:PCR0"
      values   = [var.enclave_pcr0_hash]
    }
  }

  # Allow enclave role to encrypt (for first boot key generation)
  statement {
    sid    = "AllowEnclaveEncrypt"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.enclave.arn]
    }

    actions = [
      "kms:Encrypt",
    ]

    resources = ["*"]
  }
}

variable "enclave_pcr0_hash" {
  description = "PCR0 hash of the enclave image (from nitro-cli describe-eif)"
  type        = string
  default     = "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
}

# =============================================================================
# IAM Role for EC2 Instance
# =============================================================================

resource "aws_iam_role" "enclave" {
  name = "ducat-mint-enclave-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_instance_profile" "enclave" {
  name = "ducat-mint-enclave-profile"
  role = aws_iam_role.enclave.name
}

# KMS access policy
resource "aws_iam_role_policy" "enclave_kms" {
  name = "enclave-kms-access"
  role = aws_iam_role.enclave.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:Encrypt"
        ]
        Resource = aws_kms_key.enclave_secrets.arn
      }
    ]
  })
}

# ACM certificate access for Nitro Enclaves
resource "aws_iam_role_policy" "enclave_acm" {
  name = "enclave-acm-access"
  role = aws_iam_role.enclave.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "acm:ExportCertificate",
          "acm:DescribeCertificate"
        ]
        Resource = aws_acm_certificate.mint.arn
      }
    ]
  })
}

# SSM for session manager access (optional)
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.enclave.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# =============================================================================
# ACM Certificate
# =============================================================================

resource "aws_acm_certificate" "mint" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "ducat-mint-cert"
  }
}

# Output DNS validation records (add to Route53 manually or via data source)
output "acm_validation_records" {
  description = "DNS records for ACM certificate validation"
  value = {
    for dvo in aws_acm_certificate.mint.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }
}

# =============================================================================
# EC2 Instance
# =============================================================================

resource "aws_instance" "mint" {
  ami           = data.aws_ami.amazon_linux_2023.id
  instance_type = var.instance_type
  key_name      = var.key_pair_name

  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.mint.id]
  iam_instance_profile        = aws_iam_instance_profile.enclave.name
  associate_public_ip_address = true

  # Enable Nitro Enclaves
  enclave_options {
    enabled = true
  }

  # Root volume
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 50
    encrypted             = true
    delete_on_termination = true
  }

  # User data for initial setup
  user_data = base64encode(templatefile("${path.module}/user_data.sh", {
    db_password        = var.db_password
    enclave_memory_mib = var.enclave_memory_mib
    enclave_cpu_count  = var.enclave_cpu_count
    kms_key_id         = aws_kms_key.enclave_secrets.arn
    aws_region         = var.aws_region
    acm_cert_arn       = aws_acm_certificate.mint.arn
  }))

  tags = {
    Name = "ducat-mint-enclave"
  }

  # Wait for instance to be ready
  lifecycle {
    create_before_destroy = true
  }
}

# Elastic IP for stable addressing
resource "aws_eip" "mint" {
  instance = aws_instance.mint.id
  domain   = "vpc"

  tags = {
    Name = "ducat-mint-eip"
  }
}

# =============================================================================
# Outputs
# =============================================================================

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.mint.id
}

output "public_ip" {
  description = "Public IP address"
  value       = aws_eip.mint.public_ip
}

output "mint_url" {
  description = "Mint HTTPS URL"
  value       = "https://${var.domain_name}"
}

output "kms_key_arn" {
  description = "KMS key ARN for enclave secrets"
  value       = aws_kms_key.enclave_secrets.arn
}

output "acm_certificate_arn" {
  description = "ACM certificate ARN"
  value       = aws_acm_certificate.mint.arn
}

output "ssh_command" {
  description = "SSH command to connect to instance"
  value       = "ssh -i ~/.ssh/${var.key_pair_name}.pem ec2-user@${aws_eip.mint.public_ip}"
}

output "next_steps" {
  description = "Next steps after deployment"
  value       = <<-EOT
    1. Add DNS validation records for ACM certificate
    2. Create A record: ${var.domain_name} -> ${aws_eip.mint.public_ip}
    3. SSH to instance and verify setup: ${aws_instance.mint.id}
    4. Build enclave EIF and update PCR0 hash in KMS policy
    5. Copy EIF to instance: scp mint.eif ec2-user@${aws_eip.mint.public_ip}:/opt/mint/enclave/
    6. Start enclave: nitro-cli run-enclave --eif-path /opt/mint/enclave/mint.eif --memory ${var.enclave_memory_mib} --cpu-count ${var.enclave_cpu_count}
  EOT
}
