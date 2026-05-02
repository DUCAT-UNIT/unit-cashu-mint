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

variable "confidential_space_caddy_acme_storage_enabled" {
  description = "Persist Caddy ACME storage in an attestation-gated Secret Manager secret to survive Confidential Space restarts."
  type        = bool
  default     = true
}

variable "confidential_space_caddy_acme_secret_id" {
  description = "Optional Secret Manager secret ID for Caddy ACME storage. Defaults to <name_prefix>-caddy-acme."
  type        = string
  default     = ""
}

variable "confidential_space_caddy_acme_sync_interval_seconds" {
  description = "How often the Confidential Space workload snapshots Caddy ACME storage into Secret Manager."
  type        = number
  default     = 60
}

variable "confidential_space_caddy_acme_max_bytes" {
  description = "Maximum compressed Caddy ACME storage payload size accepted for Secret Manager versions."
  type        = number
  default     = 60000
}

variable "artifact_registry_location" {
  description = "Artifact Registry location for the Confidential Space container. Defaults to region when empty."
  type        = string
  default     = ""
}

variable "artifact_registry_repository_id" {
  description = "Artifact Registry Docker repository ID for the mint container."
  type        = string
  default     = "ducat-mint"
}

variable "artifact_registry_image_name" {
  description = "Artifact Registry image name for the mint container."
  type        = string
  default     = "mint-server"
}

variable "create_artifact_registry_repository" {
  description = "Create the Artifact Registry Docker repository from this module. Disable if the repository already exists."
  type        = bool
  default     = false
}

variable "managed_postgres_enabled" {
  description = "Create a private Cloud SQL for PostgreSQL instance for Confidential Space mode."
  type        = bool
  default     = false
}

variable "managed_postgres_database_version" {
  description = "Cloud SQL PostgreSQL database version."
  type        = string
  default     = "POSTGRES_16"
}

variable "managed_postgres_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "managed_postgres_disk_size_gb" {
  description = "Cloud SQL disk size in GB."
  type        = number
  default     = 20
}

variable "managed_postgres_deletion_protection" {
  description = "Enable deletion protection on the managed Cloud SQL instance."
  type        = bool
  default     = true
}

variable "db_name" {
  description = "Mint PostgreSQL database name."
  type        = string
  default     = "mintdb"
}

variable "db_user" {
  description = "Mint PostgreSQL database user."
  type        = string
  default     = "mintuser"
}

variable "db_sslmode" {
  description = "PostgreSQL sslmode used by the Confidential Space workload when DATABASE_URL is derived from DB_* values."
  type        = string
  default     = "disable"
}

variable "manage_project_services" {
  description = "Enable the GCP APIs required by this module. Disable if APIs are managed outside Terraform."
  type        = bool
  default     = true
}

variable "audit_monitoring_enabled" {
  description = "Create Cloud Audit Logs archive and alerting for sensitive post-deploy changes."
  type        = bool
  default     = false
}

variable "audit_alert_email" {
  description = "Optional email notification channel for security audit alerts. Leave empty to create the alert policy without a notification channel."
  type        = string
  default     = ""
}

variable "audit_log_archive_bucket_name" {
  description = "Optional Cloud Storage bucket name for archived security audit logs. Defaults to <project>-<name_prefix>-audit-logs."
  type        = string
  default     = ""
}

variable "audit_log_archive_location" {
  description = "Cloud Storage location for archived audit logs. Defaults to the deployment region."
  type        = string
  default     = ""
}

variable "audit_log_retention_days" {
  description = "Minimum retention period for archived audit log objects."
  type        = number
  default     = 365
}

variable "audit_log_archive_retention_locked" {
  description = "Lock the audit log bucket retention policy. This is irreversible for the configured retention period."
  type        = bool
  default     = false
}

variable "audit_data_access_logs_enabled" {
  description = "Enable project Data Access audit logs for Cloud KMS and Secret Manager, then include them in the audit archive."
  type        = bool
  default     = false
}

locals {
  name_prefix            = "ducat-mint-${var.environment}"
  use_confidential_space = var.deployment_mode == "confidential-space"
  use_confidential_vm    = var.deployment_mode == "confidential-vm"
  artifact_registry_location = (
    var.artifact_registry_location != ""
    ? var.artifact_registry_location
    : var.region
  )
  confidential_space_pool_id = (
    var.confidential_space_workload_identity_pool_id != ""
    ? var.confidential_space_workload_identity_pool_id
    : "${local.name_prefix}-cs-pool"
  )
  confidential_space_provider_id  = var.confidential_space_workload_identity_provider_id
  confidential_space_wip_audience = "//iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${local.confidential_space_pool_id}/providers/${local.confidential_space_provider_id}"
  confidential_space_principal    = "principalSet://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${local.confidential_space_pool_id}/attribute.image_digest/${var.confidential_space_image_digest}"
  caddy_acme_storage_enabled      = local.use_confidential_space && var.confidential_space_enable_caddy && var.confidential_space_caddy_acme_storage_enabled
  caddy_acme_secret_id = (
    var.confidential_space_caddy_acme_secret_id != ""
    ? var.confidential_space_caddy_acme_secret_id
    : "${local.name_prefix}-caddy-acme"
  )
  confidential_space_attestation_conditions = compact([
    "assertion.submods.container.image_digest == '${var.confidential_space_image_digest}'",
    "'${google_service_account.mint.email}' in assertion.google_service_accounts",
    "assertion.swname == 'CONFIDENTIAL_SPACE'",
    var.confidential_space_require_stable_image ? "'STABLE' in assertion.submods.confidential_space.support_attributes" : "",
    var.confidential_space_require_production_image ? "assertion.dbgstat == 'disabled-since-boot'" : "",
  ])
  confidential_space_base_metadata = {
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
  confidential_space_caddy_metadata = local.caddy_acme_storage_enabled ? {
    "tee-env-CADDY_STORAGE_SECRET_RESOURCE"       = google_secret_manager_secret.caddy_acme[0].id
    "tee-env-CADDY_STORAGE_SYNC_INTERVAL_SECONDS" = tostring(var.confidential_space_caddy_acme_sync_interval_seconds)
    "tee-env-CADDY_STORAGE_MAX_BYTES"             = tostring(var.confidential_space_caddy_acme_max_bytes)
  } : {}
  confidential_space_managed_postgres_metadata = var.managed_postgres_enabled ? {
    "tee-env-DB_HOST"    = google_sql_database_instance.mint[0].private_ip_address
    "tee-env-DB_PORT"    = "5432"
    "tee-env-DB_NAME"    = var.db_name
    "tee-env-DB_USER"    = var.db_user
    "tee-env-DB_SSLMODE" = var.db_sslmode
  } : {}
  confidential_space_metadata = merge(
    local.confidential_space_base_metadata,
    local.confidential_space_caddy_metadata,
    local.confidential_space_managed_postgres_metadata
  )
  labels = {
    app         = "ducat-mint"
    environment = var.environment
    managed_by  = "terraform"
  }
  audit_log_archive_bucket_name = (
    var.audit_log_archive_bucket_name != ""
    ? var.audit_log_archive_bucket_name
    : "${var.project_id}-${local.name_prefix}-audit-logs"
  )
  audit_log_archive_location = (
    var.audit_log_archive_location != ""
    ? var.audit_log_archive_location
    : upper(var.region)
  )
  audit_admin_activity_filter = trimspace(<<-EOT
    log_id("cloudaudit.googleapis.com/activity")
    AND (
      protoPayload.methodName:"SetIamPolicy"
      OR protoPayload.methodName:"CreateWorkloadIdentityPool"
      OR protoPayload.methodName:"UpdateWorkloadIdentityPool"
      OR protoPayload.methodName:"DeleteWorkloadIdentityPool"
      OR protoPayload.methodName:"CreateWorkloadIdentityPoolProvider"
      OR protoPayload.methodName:"UpdateWorkloadIdentityPoolProvider"
      OR protoPayload.methodName:"DeleteWorkloadIdentityPoolProvider"
      OR protoPayload.methodName:"UpdateCryptoKey"
      OR protoPayload.methodName:"DestroyCryptoKeyVersion"
      OR protoPayload.methodName:"RestoreCryptoKeyVersion"
      OR protoPayload.methodName:"UpdateSecret"
      OR protoPayload.methodName:"AddSecretVersion"
      OR protoPayload.methodName:"DestroySecretVersion"
      OR protoPayload.methodName:"DisableSecretVersion"
      OR protoPayload.methodName:"EnableSecretVersion"
      OR protoPayload.methodName:"instances.insert"
      OR protoPayload.methodName:"instances.delete"
      OR protoPayload.methodName:"instances.setMetadata"
      OR protoPayload.methodName:"instances.setServiceAccount"
      OR protoPayload.methodName:"instances.stop"
      OR protoPayload.methodName:"instances.start"
      OR protoPayload.methodName:"sql.instances.update"
      OR protoPayload.methodName:"CreateServiceAccountKey"
    )
  EOT
  )
  audit_data_access_filter = trimspace(<<-EOT
    log_id("cloudaudit.googleapis.com/data_access")
    AND (
      protoPayload.serviceName="cloudkms.googleapis.com"
      OR protoPayload.serviceName="secretmanager.googleapis.com"
    )
  EOT
  )
  audit_archive_filter = (
    var.audit_data_access_logs_enabled
    ? "(${local.audit_admin_activity_filter}) OR (${local.audit_data_access_filter})"
    : local.audit_admin_activity_filter
  )
  required_project_services = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudkms.googleapis.com",
    "compute.googleapis.com",
    "confidentialcomputing.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ])
}

resource "google_project_service" "required" {
  for_each = var.manage_project_services ? local.required_project_services : toset([])
  project  = var.project_id
  service  = each.value

  disable_on_destroy = false
}

resource "google_storage_bucket" "audit_logs" {
  count                       = var.audit_monitoring_enabled ? 1 : 0
  name                        = local.audit_log_archive_bucket_name
  location                    = local.audit_log_archive_location
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  versioning {
    enabled = true
  }

  retention_policy {
    retention_period = var.audit_log_retention_days * 86400
    is_locked        = var.audit_log_archive_retention_locked
  }

  depends_on = [google_project_service.required]
}

resource "google_logging_project_sink" "security_audit_archive" {
  count                  = var.audit_monitoring_enabled ? 1 : 0
  name                   = "${local.name_prefix}-security-audit-archive"
  destination            = "storage.googleapis.com/${google_storage_bucket.audit_logs[0].name}"
  filter                 = local.audit_archive_filter
  unique_writer_identity = true

  depends_on = [
    google_project_service.required,
    google_storage_bucket.audit_logs,
  ]
}

resource "google_storage_bucket_iam_member" "audit_log_sink_writer" {
  count  = var.audit_monitoring_enabled ? 1 : 0
  bucket = google_storage_bucket.audit_logs[0].name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.security_audit_archive[0].writer_identity
}

resource "google_project_iam_audit_config" "cloudkms_data_access" {
  count   = var.audit_monitoring_enabled && var.audit_data_access_logs_enabled ? 1 : 0
  project = var.project_id
  service = "cloudkms.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

resource "google_project_iam_audit_config" "secretmanager_data_access" {
  count   = var.audit_monitoring_enabled && var.audit_data_access_logs_enabled ? 1 : 0
  project = var.project_id
  service = "secretmanager.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

resource "google_monitoring_notification_channel" "audit_email" {
  count        = var.audit_monitoring_enabled && var.audit_alert_email != "" ? 1 : 0
  display_name = "${local.name_prefix} security audit email"
  type         = "email"
  labels = {
    email_address = var.audit_alert_email
  }
  enabled = true

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "security_admin_activity" {
  count        = var.audit_monitoring_enabled ? 1 : 0
  display_name = "${local.name_prefix} sensitive admin audit activity"
  combiner     = "OR"
  enabled      = true

  notification_channels = (
    var.audit_alert_email != ""
    ? [google_monitoring_notification_channel.audit_email[0].name]
    : []
  )

  conditions {
    display_name = "Sensitive admin audit log entry"

    condition_matched_log {
      filter = local.audit_admin_activity_filter
      label_extractors = {
        method    = "EXTRACT(protoPayload.methodName)"
        principal = "EXTRACT(protoPayload.authenticationInfo.principalEmail)"
        resource  = "EXTRACT(protoPayload.resourceName)"
      }
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }

    auto_close = "604800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Sensitive Ducat mint infrastructure changed. Review the audit log entry, confirm the actor, and rerun `npm run gcp:confidential-space:attest` against the live deployment."
  }

  depends_on = [google_project_service.required]
}

resource "google_compute_network" "mint" {
  name                    = "${local.name_prefix}-network"
  auto_create_subnetworks = false

  depends_on = [google_project_service.required]
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

resource "google_artifact_registry_repository" "mint" {
  count         = var.create_artifact_registry_repository ? 1 : 0
  location      = local.artifact_registry_location
  repository_id = var.artifact_registry_repository_id
  description   = "Ducat mint Confidential Space workload images"
  format        = "DOCKER"
  labels        = local.labels

  depends_on = [google_project_service.required]
}

resource "google_compute_global_address" "private_services" {
  count         = var.managed_postgres_enabled ? 1 : 0
  name          = "${local.name_prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.mint.id
}

resource "google_service_networking_connection" "private_vpc" {
  count                   = var.managed_postgres_enabled ? 1 : 0
  network                 = google_compute_network.mint.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services[0].name]
}

resource "google_sql_database_instance" "mint" {
  count               = var.managed_postgres_enabled ? 1 : 0
  name                = "${local.name_prefix}-postgres"
  database_version    = var.managed_postgres_database_version
  region              = var.region
  deletion_protection = var.managed_postgres_deletion_protection
  encryption_key_name = google_kms_crypto_key.mint.id

  settings {
    tier              = var.managed_postgres_tier
    availability_type = "ZONAL"
    disk_autoresize   = true
    disk_size         = var.managed_postgres_disk_size_gb
    disk_type         = "PD_SSD"

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.mint.id
    }

    user_labels = local.labels
  }

  depends_on = [
    google_kms_crypto_key_iam_member.cloud_sql_cmek,
    google_service_networking_connection.private_vpc,
  ]
}

resource "google_sql_database" "mint" {
  count    = var.managed_postgres_enabled ? 1 : 0
  name     = var.db_name
  instance = google_sql_database_instance.mint[0].name
}

resource "google_sql_user" "mint" {
  count    = var.managed_postgres_enabled ? 1 : 0
  name     = var.db_user
  instance = google_sql_database_instance.mint[0].name
  password = var.db_password
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

  depends_on = [google_project_service.required]
}

resource "google_kms_key_ring" "mint" {
  name     = "${local.name_prefix}-keyring"
  location = var.region

  depends_on = [google_project_service.required]
}

resource "google_kms_crypto_key" "mint" {
  name            = "${local.name_prefix}-secrets"
  key_ring        = google_kms_key_ring.mint.id
  rotation_period = "2592000s"
}

resource "google_kms_key_ring" "secret_manager" {
  name     = "${local.name_prefix}-secret-manager-keyring"
  location = "global"

  depends_on = [google_project_service.required]
}

resource "google_kms_crypto_key" "secret_manager" {
  name            = "${local.name_prefix}-secret-manager"
  key_ring        = google_kms_key_ring.secret_manager.id
  rotation_period = "2592000s"
}

data "google_secret_manager_secret" "mint_env" {
  secret_id = var.mint_env_secret_id

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "caddy_acme" {
  count     = local.caddy_acme_storage_enabled ? 1 : 0
  secret_id = local.caddy_acme_secret_id
  labels    = local.labels

  replication {
    auto {
      customer_managed_encryption {
        kms_key_name = google_kms_crypto_key.secret_manager.id
      }
    }
  }

  depends_on = [
    google_kms_crypto_key_iam_member.secret_manager_cmek,
    google_project_service.required,
  ]
}

resource "google_project_service_identity" "secret_manager" {
  provider = google-beta
  project  = var.project_id
  service  = "secretmanager.googleapis.com"

  depends_on = [google_project_service.required]
}

resource "google_project_service_identity" "cloud_sql" {
  count    = var.managed_postgres_enabled ? 1 : 0
  provider = google-beta
  project  = var.project_id
  service  = "sqladmin.googleapis.com"

  depends_on = [google_project_service.required]
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

resource "google_kms_crypto_key_iam_member" "cloud_sql_cmek" {
  count         = var.managed_postgres_enabled ? 1 : 0
  crypto_key_id = google_kms_crypto_key.mint.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = google_project_service_identity.cloud_sql[0].member
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

resource "google_secret_manager_secret_iam_member" "confidential_space_caddy_acme_accessor" {
  count     = local.caddy_acme_storage_enabled ? 1 : 0
  secret_id = google_secret_manager_secret.caddy_acme[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.confidential_space_principal

  depends_on = [google_iam_workload_identity_pool_provider.confidential_space]
}

resource "google_secret_manager_secret_iam_member" "confidential_space_caddy_acme_version_adder" {
  count     = local.caddy_acme_storage_enabled ? 1 : 0
  secret_id = google_secret_manager_secret.caddy_acme[0].id
  role      = "roles/secretmanager.secretVersionAdder"
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
    google_secret_manager_secret_iam_member.confidential_space_caddy_acme_accessor,
    google_secret_manager_secret_iam_member.confidential_space_caddy_acme_version_adder,
    google_project_iam_member.artifact_registry_reader,
    google_project_iam_member.confidential_space_log_writer,
    google_sql_database.mint,
    google_sql_user.mint,
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

output "artifact_registry_repository" {
  description = "Artifact Registry Docker repository name used for Confidential Space images."
  value       = "${local.artifact_registry_location}-docker.pkg.dev/${var.project_id}/${var.artifact_registry_repository_id}"
}

output "managed_postgres_private_ip" {
  description = "Private Cloud SQL address used by Confidential Space when managed_postgres_enabled=true."
  value       = var.managed_postgres_enabled ? google_sql_database_instance.mint[0].private_ip_address : null
}

output "secret_manager_cmek_key_name" {
  description = "Cloud KMS key to use as the Secret Manager CMEK for the mint env secret."
  value       = google_kms_crypto_key.secret_manager.id
}

output "audit_log_archive_bucket" {
  description = "Cloud Storage bucket that receives sensitive Cloud Audit Logs when audit monitoring is enabled."
  value       = var.audit_monitoring_enabled ? google_storage_bucket.audit_logs[0].name : null
}

output "audit_alert_policy_name" {
  description = "Cloud Monitoring alert policy for sensitive admin audit activity when audit monitoring is enabled."
  value       = var.audit_monitoring_enabled ? google_monitoring_alert_policy.security_admin_activity[0].name : null
}

output "caddy_acme_storage_secret_name" {
  description = "Secret Manager secret used to persist Caddy ACME storage in Confidential Space mode."
  value       = local.caddy_acme_storage_enabled ? google_secret_manager_secret.caddy_acme[0].id : null
}
