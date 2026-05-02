terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.45"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.45"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

provider "google-beta" {
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

variable "deployment_mode" {
  description = "Deployment mode. Use confidential-vm for the current VM startup-script deployment or confidential-space for attestation-gated container execution."
  type        = string
  default     = "confidential-vm"

  validation {
    condition     = contains(["confidential-vm", "confidential-space"], var.deployment_mode)
    error_message = "deployment_mode must be either confidential-vm or confidential-space."
  }
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

variable "require_confidential_vm_attestation" {
  description = "Fail startup before fetching secrets unless Compute Engine reports Confidential VM and Shielded VM are enabled."
  type        = bool
  default     = true
}

variable "confidential_space_image_reference" {
  description = "Artifact Registry container image reference for Confidential Space, preferably pinned with @sha256."
  type        = string
  default     = ""
}

variable "confidential_space_image_digest" {
  description = "Expected workload container image digest, for example sha256:abc123. KMS and Secret Manager access are bound to this attested digest."
  type        = string
  default     = ""
}

variable "confidential_space_image_family" {
  description = "Confidential Space image family. Use confidential-space for production or confidential-space-debug only while debugging."
  type        = string
  default     = "confidential-space"
}

variable "confidential_space_workload_identity_pool_id" {
  description = "Optional Workload Identity Pool ID for Confidential Space attestation."
  type        = string
  default     = ""
}

variable "confidential_space_workload_identity_provider_id" {
  description = "Workload Identity Pool provider ID for Confidential Space attestation."
  type        = string
  default     = "attestation-verifier"
}

variable "confidential_space_require_stable_image" {
  description = "Require the STABLE Confidential Space support attribute in the attestation policy."
  type        = bool
  default     = true
}

variable "confidential_space_require_production_image" {
  description = "Require a production Confidential Space image by checking dbgstat == disabled-since-boot."
  type        = bool
  default     = true
}

variable "confidential_space_log_redirect" {
  description = "Confidential Space launcher log redirection mode."
  type        = string
  default     = "cloud_logging"
}

variable "confidential_space_enable_caddy" {
  description = "Run Caddy inside the attested workload container for TLS termination."
  type        = bool
  default     = true
}

locals {
  name_prefix            = "ducat-mint-${var.environment}"
  use_confidential_space = var.deployment_mode == "confidential-space"
  use_confidential_vm    = var.deployment_mode == "confidential-vm"
  confidential_space_pool_id = (
    var.confidential_space_workload_identity_pool_id != ""
    ? var.confidential_space_workload_identity_pool_id
    : "${local.name_prefix}-cs-pool"
  )
  confidential_space_provider_id  = var.confidential_space_workload_identity_provider_id
  confidential_space_wip_audience = "//iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${local.confidential_space_pool_id}/providers/${local.confidential_space_provider_id}"
  confidential_space_principal    = "principalSet://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${local.confidential_space_pool_id}/attribute.image_digest/${var.confidential_space_image_digest}"
  confidential_space_attestation_conditions = compact([
    "assertion.submods.container.image_digest == '${var.confidential_space_image_digest}'",
    "'${google_service_account.mint.email}' in assertion.google_service_accounts",
    "assertion.swname == 'CONFIDENTIAL_SPACE'",
    var.confidential_space_require_stable_image ? "'STABLE' in assertion.submods.confidential_space.support_attributes" : "",
    var.confidential_space_require_production_image ? "assertion.dbgstat == 'disabled-since-boot'" : "",
  ])
  confidential_space_metadata = {
    "tee-image-reference"                    = var.confidential_space_image_reference
    "tee-restart-policy"                     = "Always"
    "tee-container-log-redirect"             = var.confidential_space_log_redirect
    "tee-env-GCP_PROJECT_ID"                 = var.project_id
    "tee-env-GCP_WORKLOAD_IDENTITY_AUDIENCE" = local.confidential_space_wip_audience
    "tee-env-GCP_ATTESTATION_TOKEN_AUDIENCE" = "https://sts.googleapis.com"
    "tee-env-MINT_ENV_SECRET_RESOURCE"       = data.google_secret_manager_secret.mint_env.id
    "tee-env-KMS_KEY_NAME"                   = google_kms_crypto_key.mint.id
    "tee-env-DOMAIN_NAME"                    = var.domain_name
    "tee-env-TLS_EMAIL"                      = var.tls_email
    "tee-env-CADDY_ENABLED"                  = tostring(var.confidential_space_enable_caddy)
  }
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

resource "google_kms_key_ring" "secret_manager" {
  name     = "${local.name_prefix}-secret-manager-keyring"
  location = "global"
}

resource "google_kms_crypto_key" "secret_manager" {
  name            = "${local.name_prefix}-secret-manager"
  key_ring        = google_kms_key_ring.secret_manager.id
  rotation_period = "2592000s"
}

data "google_secret_manager_secret" "mint_env" {
  secret_id = var.mint_env_secret_id
}

resource "google_project_service_identity" "secret_manager" {
  provider = google-beta
  project  = var.project_id
  service  = "secretmanager.googleapis.com"
}

resource "google_secret_manager_secret_iam_member" "mint_env_accessor" {
  count     = local.use_confidential_vm ? 1 : 0
  secret_id = data.google_secret_manager_secret.mint_env.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.mint.email}"
}

resource "google_kms_crypto_key_iam_member" "mint_decrypter" {
  count         = local.use_confidential_vm ? 1 : 0
  crypto_key_id = google_kms_crypto_key.mint.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.mint.email}"
}

resource "google_kms_crypto_key_iam_member" "secret_manager_cmek" {
  crypto_key_id = google_kms_crypto_key.secret_manager.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = google_project_service_identity.secret_manager.member
}

resource "google_kms_crypto_key_iam_member" "compute_engine_encrypter_decrypter" {
  crypto_key_id = google_kms_crypto_key.mint.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@compute-system.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "confidential_workload_user" {
  project = var.project_id
  role    = "roles/confidentialcomputing.workloadUser"
  member  = "serviceAccount:${google_service_account.mint.email}"
}

resource "google_project_iam_member" "compute_viewer" {
  count   = local.use_confidential_vm ? 1 : 0
  project = var.project_id
  role    = "roles/compute.viewer"
  member  = "serviceAccount:${google_service_account.mint.email}"
}

resource "google_project_iam_member" "artifact_registry_reader" {
  count   = local.use_confidential_space ? 1 : 0
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.mint.email}"
}

resource "google_project_iam_member" "confidential_space_log_writer" {
  count   = local.use_confidential_space ? 1 : 0
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.mint.email}"
}

resource "google_iam_workload_identity_pool" "confidential_space" {
  count                     = local.use_confidential_space ? 1 : 0
  workload_identity_pool_id = local.confidential_space_pool_id
  display_name              = "Ducat mint Confidential Space"
  description               = "Federates Google Cloud Attestation tokens for the Ducat mint workload."
}

resource "google_iam_workload_identity_pool_provider" "confidential_space" {
  count                              = local.use_confidential_space ? 1 : 0
  workload_identity_pool_id          = google_iam_workload_identity_pool.confidential_space[0].workload_identity_pool_id
  workload_identity_pool_provider_id = local.confidential_space_provider_id
  display_name                       = "Confidential Space attestation"
  description                        = "Allows only the expected Ducat mint Confidential Space workload to access protected resources."

  attribute_mapping = {
    "google.subject"         = "\"gcpcs::\" + assertion.submods.container.image_digest + \"::\" + assertion.submods.gce.project_number + \"::\" + assertion.submods.gce.instance_id"
    "attribute.image_digest" = "assertion.submods.container.image_digest"
  }

  attribute_condition = join(" && ", local.confidential_space_attestation_conditions)

  oidc {
    issuer_uri        = "https://confidentialcomputing.googleapis.com/"
    allowed_audiences = ["https://sts.googleapis.com"]
  }
}

resource "google_kms_crypto_key_iam_member" "confidential_space_mint_encrypter_decrypter" {
  count         = local.use_confidential_space ? 1 : 0
  crypto_key_id = google_kms_crypto_key.mint.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.confidential_space_principal

  depends_on = [google_iam_workload_identity_pool_provider.confidential_space]
}

resource "google_secret_manager_secret_iam_member" "confidential_space_mint_env_accessor" {
  count     = local.use_confidential_space ? 1 : 0
  secret_id = data.google_secret_manager_secret.mint_env.id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.confidential_space_principal

  depends_on = [google_iam_workload_identity_pool_provider.confidential_space]
}

data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2204-lts"
  project = "ubuntu-os-cloud"
}

data "google_compute_image" "confidential_space" {
  count   = local.use_confidential_space ? 1 : 0
  family  = var.confidential_space_image_family
  project = "confidential-space-images"
}

resource "google_compute_instance" "mint" {
  count        = local.use_confidential_vm ? 1 : 0
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
    project_id                          = var.project_id
    repo_url                            = var.repo_url
    repo_ref                            = var.repo_ref
    domain_name                         = var.domain_name
    tls_email                           = var.tls_email
    mint_env_secret_id                  = var.mint_env_secret_id
    db_password                         = var.db_password
    app_kms_key_name                    = google_kms_crypto_key.mint.id
    require_confidential_vm_attestation = var.require_confidential_vm_attestation
    confidential_instance_type          = var.confidential_instance_type
  })
}

resource "google_compute_instance" "confidential_space" {
  count        = local.use_confidential_space ? 1 : 0
  name         = "${local.name_prefix}-confidential-space"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["ducat-mint"]
  labels       = local.labels

  boot_disk {
    initialize_params {
      image = data.google_compute_image.confidential_space[0].self_link
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

  metadata = local.confidential_space_metadata

  lifecycle {
    precondition {
      condition = (
        var.confidential_space_image_reference != "" &&
        var.confidential_space_image_digest != ""
      )
      error_message = "confidential_space_image_reference and confidential_space_image_digest are required when deployment_mode=confidential-space."
    }
  }

  depends_on = [
    google_iam_workload_identity_pool_provider.confidential_space,
    google_kms_crypto_key_iam_member.confidential_space_mint_encrypter_decrypter,
    google_secret_manager_secret_iam_member.confidential_space_mint_env_accessor,
    google_project_iam_member.artifact_registry_reader,
    google_project_iam_member.confidential_space_log_writer,
  ]
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
  description = "Compute instance name."
  value = (
    local.use_confidential_space
    ? google_compute_instance.confidential_space[0].name
    : google_compute_instance.mint[0].name
  )
}

output "service_account_email" {
  description = "Runtime service account."
  value       = google_service_account.mint.email
}

output "mint_env_secret_name" {
  description = "Secret Manager secret that must contain mint env vars."
  value       = data.google_secret_manager_secret.mint_env.id
}

output "app_kms_key_name" {
  description = "Cloud KMS key used by the mint app for keyset private-key encryption."
  value       = google_kms_crypto_key.mint.id
}

output "confidential_space_workload_identity_audience" {
  description = "STS audience used by the Confidential Space workload."
  value       = local.confidential_space_wip_audience
}

output "confidential_space_expected_image_digest" {
  description = "Container digest that is allowed to decrypt with KMS in Confidential Space mode."
  value       = var.confidential_space_image_digest
}

output "secret_manager_cmek_key_name" {
  description = "Cloud KMS key to use as the Secret Manager CMEK for the mint env secret."
  value       = google_kms_crypto_key.secret_manager.id
}
