terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.45"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

data "google_project" "current" {
  project_id = var.project_id
}

variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "GCP region."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone. Pick a zone that supports your selected Confidential VM type."
  type        = string
  default     = "us-central1-a"
}

variable "environment" {
  description = "Deployment environment."
  type        = string
  default     = "prod"
}

variable "domain_name" {
  description = "DNS name that will point to this mint."
  type        = string
}

variable "tls_email" {
  description = "Email used by Caddy for ACME certificate registration."
  type        = string
}

variable "repo_url" {
  description = "Git repository URL for the mint server."
  type        = string
}

variable "repo_ref" {
  description = "Git branch, tag, or commit to deploy."
  type        = string
  default     = "main"
}

variable "machine_type" {
  description = "Confidential VM machine type."
  type        = string
  default     = "n2d-standard-4"
}

variable "confidential_instance_type" {
  description = "Confidential computing technology. Common values are SEV, SEV_SNP, or TDX depending on zone and machine family support."
  type        = string
  default     = "SEV"
}

variable "boot_disk_size_gb" {
  description = "Boot disk size."
  type        = number
  default     = 50
}

variable "mint_env_secret_id" {
  description = "Secret Manager secret ID containing newline-separated KEY=VALUE mint environment variables."
  type        = string
  default     = "ducat-mint-env"
}

variable "db_password" {
  description = "Local PostgreSQL mint user password."
  type        = string
  sensitive   = true
}

variable "admin_cidr_blocks" {
  description = "CIDR blocks allowed to SSH to the VM. Leave empty to disable direct SSH."
  type        = list(string)
  default     = []
}

locals {
  name_prefix = "ducat-mint-${var.environment}"
  labels = {
    app         = "ducat-mint"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_compute_network" "mint" {
  name                    = "${local.name_prefix}-network"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "mint" {
  name          = "${local.name_prefix}-subnet"
  ip_cidr_range = "10.10.0.0/24"
  network       = google_compute_network.mint.id
  region        = var.region
}

resource "google_compute_address" "mint" {
  name   = "${local.name_prefix}-ip"
  region = var.region
}

resource "google_compute_firewall" "https" {
  name    = "${local.name_prefix}-https"
  network = google_compute_network.mint.name

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["ducat-mint"]
}

resource "google_compute_firewall" "ssh" {
  count   = length(var.admin_cidr_blocks) > 0 ? 1 : 0
  name    = "${local.name_prefix}-ssh"
  network = google_compute_network.mint.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.admin_cidr_blocks
  target_tags   = ["ducat-mint"]
}

resource "google_service_account" "mint" {
  account_id   = "${local.name_prefix}-sa"
  display_name = "Ducat mint Confidential VM service account"
}

resource "google_kms_key_ring" "mint" {
  name     = "${local.name_prefix}-keyring"
  location = var.region
}

resource "google_kms_crypto_key" "mint" {
  name            = "${local.name_prefix}-secrets"
  key_ring        = google_kms_key_ring.mint.id
  rotation_period = "2592000s"
}

data "google_secret_manager_secret" "mint_env" {
  secret_id = var.mint_env_secret_id
}

resource "google_secret_manager_secret_iam_member" "mint_env_accessor" {
  secret_id = data.google_secret_manager_secret.mint_env.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.mint.email}"
}

resource "google_kms_crypto_key_iam_member" "mint_decrypter" {
  crypto_key_id = google_kms_crypto_key.mint.id
  role          = "roles/cloudkms.cryptoKeyDecrypter"
  member        = "serviceAccount:${google_service_account.mint.email}"
}

resource "google_kms_crypto_key_iam_member" "compute_engine_encrypter_decrypter" {
  crypto_key_id = google_kms_crypto_key.mint.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@compute-system.iam.gserviceaccount.com"
}

data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2204-lts"
  project = "ubuntu-os-cloud"
}

resource "google_compute_instance" "mint" {
  name         = "${local.name_prefix}-confidential-vm"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["ducat-mint"]
  labels       = local.labels

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = var.boot_disk_size_gb
      type  = "pd-balanced"
    }
    kms_key_self_link = google_kms_crypto_key.mint.id
  }

  network_interface {
    subnetwork = google_compute_subnetwork.mint.id
    access_config {
      nat_ip = google_compute_address.mint.address
    }
  }

  service_account {
    email  = google_service_account.mint.email
    scopes = ["cloud-platform"]
  }

  confidential_instance_config {
    enable_confidential_compute = true
    confidential_instance_type  = var.confidential_instance_type
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  scheduling {
    on_host_maintenance = var.confidential_instance_type == "SEV" ? "MIGRATE" : "TERMINATE"
  }

  metadata_startup_script = templatefile("${path.module}/startup.sh", {
    project_id         = var.project_id
    repo_url           = var.repo_url
    repo_ref           = var.repo_ref
    domain_name        = var.domain_name
    tls_email          = var.tls_email
    mint_env_secret_id = var.mint_env_secret_id
    db_password        = var.db_password
  })
}

output "public_ip" {
  description = "Static public IP. Point the mint DNS A record here before first Caddy TLS issuance."
  value       = google_compute_address.mint.address
}

output "mint_url" {
  description = "Mint URL."
  value       = "https://${var.domain_name}"
}

output "instance_name" {
  description = "Confidential VM instance name."
  value       = google_compute_instance.mint.name
}

output "service_account_email" {
  description = "Runtime service account."
  value       = google_service_account.mint.email
}

output "mint_env_secret_name" {
  description = "Secret Manager secret that must contain mint env vars."
  value       = data.google_secret_manager_secret.mint_env.id
}
