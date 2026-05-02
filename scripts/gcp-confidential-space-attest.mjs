#!/usr/bin/env node
import { createHash, createSign } from 'node:crypto'
import { resolve4 } from 'node:dns/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = parseArgs(process.argv.slice(2))
const tfvars = await readTfvars(args.tfvars ?? join(repoRoot, 'terraform/gcp/terraform.tfvars'))

const projectId = required(
  args.project ??
    process.env.GCP_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.TF_VAR_project_id ??
    tfvars.project_id,
  'GCP project is required. Pass --project or set TF_VAR_project_id/project_id.'
)
const region =
  args.region ??
  process.env.GCP_REGION ??
  process.env.TF_VAR_region ??
  tfvars.region ??
  'us-central1'
const zone =
  args.zone ?? process.env.GCP_ZONE ?? process.env.TF_VAR_zone ?? tfvars.zone ?? 'us-central1-a'
const environment =
  args.environment ?? process.env.TF_VAR_environment ?? tfvars.environment ?? 'prod'
const namePrefix = args['name-prefix'] ?? `ducat-mint-${environment}`
const domainName = required(
  args.domain ??
    args['domain-name'] ??
    process.env.DOMAIN_NAME ??
    process.env.TF_VAR_domain_name ??
    tfvars.domain_name,
  'Domain name is required. Pass --domain or set TF_VAR_domain_name/domain_name.'
)
const configuredImageReference =
  args['image-reference'] ??
  process.env.CONFIDENTIAL_SPACE_IMAGE_REFERENCE ??
  process.env.TF_VAR_confidential_space_image_reference
const configuredImageDigest =
  args['image-digest'] ??
  process.env.CONFIDENTIAL_SPACE_IMAGE_DIGEST ??
  process.env.TF_VAR_confidential_space_image_digest
let imageReference = configuredImageReference
let imageDigest = configuredImageDigest
const mintEnvSecretId =
  args['mint-env-secret-id'] ??
  process.env.TF_VAR_mint_env_secret_id ??
  tfvars.mint_env_secret_id ??
  'ducat-mint-env'
const workloadIdentityPoolId =
  args['workload-identity-pool-id'] ??
  process.env.TF_VAR_confidential_space_workload_identity_pool_id ??
  tfvars.confidential_space_workload_identity_pool_id ??
  `${namePrefix}-cs-pool`
const workloadIdentityProviderId =
  args['workload-identity-provider-id'] ??
  process.env.TF_VAR_confidential_space_workload_identity_provider_id ??
  tfvars.confidential_space_workload_identity_provider_id ??
  'attestation-verifier'
const expectedConfidentialInstanceType =
  args['confidential-instance-type'] ??
  process.env.TF_VAR_confidential_instance_type ??
  tfvars.confidential_instance_type ??
  'SEV'
const managedPostgresEnabled = parseBoolean(
  args['managed-postgres-enabled'] ??
    process.env.TF_VAR_managed_postgres_enabled ??
    tfvars.managed_postgres_enabled ??
    false
)
const auditMonitoringEnabled = parseBoolean(
  args['require-audit-monitoring'] ??
    process.env.REQUIRE_AUDIT_MONITORING ??
    process.env.TF_VAR_audit_monitoring_enabled ??
    tfvars.audit_monitoring_enabled ??
    false
)
const auditDataAccessLogsEnabled = parseBoolean(
  args['audit-data-access-logs-enabled'] ??
    process.env.TF_VAR_audit_data_access_logs_enabled ??
    tfvars.audit_data_access_logs_enabled ??
    false
)
const caddyAcmeStorageEnabled = parseBoolean(
  args['caddy-acme-storage-enabled'] ??
    process.env.TF_VAR_confidential_space_caddy_acme_storage_enabled ??
    tfvars.confidential_space_caddy_acme_storage_enabled ??
    true
)
const configuredCaddyAcmeSecretId =
  args['caddy-acme-secret-id'] ??
  process.env.TF_VAR_confidential_space_caddy_acme_secret_id ??
  tfvars.confidential_space_caddy_acme_secret_id
const caddyAcmeSecretId =
  configuredCaddyAcmeSecretId && configuredCaddyAcmeSecretId !== ''
    ? configuredCaddyAcmeSecretId
    : `${namePrefix}-caddy-acme`
const configuredAuditLogArchiveBucketName =
  args['audit-log-archive-bucket-name'] ??
  process.env.TF_VAR_audit_log_archive_bucket_name ??
  tfvars.audit_log_archive_bucket_name
const auditLogArchiveBucketName =
  configuredAuditLogArchiveBucketName && configuredAuditLogArchiveBucketName !== ''
    ? configuredAuditLogArchiveBucketName
    : `${projectId}-${namePrefix}-audit-logs`
const outputDir = resolve(repoRoot, args['output-dir'] ?? 'attestations')
const instanceName = args.instance ?? `${namePrefix}-confidential-space`
const runtimeServiceAccount =
  args['service-account'] ?? `${namePrefix}-sa@${projectId}.iam.gserviceaccount.com`
const appKmsKeyName =
  args['kms-key-name'] ??
  `projects/${projectId}/locations/${region}/keyRings/${namePrefix}-keyring/cryptoKeys/${namePrefix}-secrets`
const secretManagerKmsKeyName =
  args['secret-manager-kms-key-name'] ??
  `projects/${projectId}/locations/global/keyRings/${namePrefix}-secret-manager-keyring/cryptoKeys/${namePrefix}-secret-manager`
const secretResource = `projects/${projectId}/secrets/${mintEnvSecretId}`
const caddyAcmeSecretResource = `projects/${projectId}/secrets/${caddyAcmeSecretId}`

const token = await getAccessToken()
const checks = []
const evidence = {}

const project = await googleFetch(
  token,
  `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`
)
const projectNumber = String(project.projectNumber)
if (!imageReference || !imageDigest) {
  const discoveredImage = await discoverImageFromInstance()
  imageReference =
    imageReference || discoveredImage.imageReference || tfvars.confidential_space_image_reference
  imageDigest = imageDigest || discoveredImage.imageDigest || tfvars.confidential_space_image_digest
}

imageReference = required(imageReference, 'Confidential Space image reference is required.')
imageDigest = required(imageDigest, 'Confidential Space image digest is required.')

const confidentialSpacePrincipal =
  `principalSet://iam.googleapis.com/projects/${projectNumber}` +
  `/locations/global/workloadIdentityPools/${workloadIdentityPoolId}` +
  `/attribute.image_digest/${imageDigest}`
const digestPrincipalPrefix =
  `principalSet://iam.googleapis.com/projects/${projectNumber}` +
  `/locations/global/workloadIdentityPools/${workloadIdentityPoolId}` +
  '/attribute.image_digest/'

await collectComputeEvidence()
await collectWorkloadIdentityEvidence()
await collectIamEvidence()
await collectSecretEvidence()
if (caddyAcmeStorageEnabled) {
  await collectCaddyAcmeStorageEvidence()
}
if (managedPostgresEnabled) {
  await collectCloudSqlEvidence()
}
if (auditMonitoringEnabled) {
  await collectAuditMonitoringEvidence()
}
await collectEndpointEvidence()

const failed = checks.filter((check) => check.required && !check.ok)
const predicateType = 'https://ducatprotocol.com/attestations/gcp-confidential-space-release/v1'
const predicate = {
  predicateType,
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  result: failed.length === 0 ? 'pass' : 'fail',
  subject: {
    imageReference,
    imageDigest,
  },
  target: {
    projectId,
    projectNumber,
    region,
    zone,
    environment,
    domainName,
    instanceName,
    runtimeServiceAccount,
  },
  ci: githubContext(),
  claims: {
    verifierDidNotReadSecretPayloads: true,
    verifierDidNotRequestKmsDecrypt: true,
    verifierDidNotRequestKmsEncrypt: true,
    kmsKeyMaterialWasNotExportedToCi: true,
    appKmsAccessIsBoundToAttestedImageDigest: checkOk('kms.current_digest_principal_has_decrypt'),
    secretManagerAccessIsBoundToAttestedImageDigest: checkOk(
      'secret.current_digest_principal_has_access'
    ),
    runtimeServiceAccountHasNoDirectAppKmsAccess: checkOk(
      'kms.runtime_service_account_has_no_direct_access'
    ),
    runtimeServiceAccountHasNoDirectSecretAccess: checkOk(
      'secret.runtime_service_account_has_no_direct_access'
    ),
    instanceMetadataContainsNoSecretPayloads: checkOk(
      'compute.metadata_contains_no_secret_payloads'
    ),
    workloadIdentityRequiresExpectedDigest: checkOk('wif.condition_requires_digest'),
    workloadIdentityRequiresConfidentialSpace: checkOk('wif.condition_requires_confidential_space'),
    workloadIdentityRequiresProductionImage: checkOk('wif.condition_requires_production_image'),
    auditMonitoringIsConfigured: auditMonitoringEnabled
      ? checkOk('audit.archive_sink_exists')
      : null,
    kmsAndSecretDataAccessLogsAreEnabled: auditDataAccessLogsEnabled
      ? checkOk('audit.kms_data_access_logs_enabled') &&
        checkOk('audit.secretmanager_data_access_logs_enabled')
      : null,
    caddyAcmeStorageIsPersisted: caddyAcmeStorageEnabled
      ? checkOk('caddy_acme.secret_exists') &&
        checkOk('caddy_acme.current_digest_principal_can_add_versions')
      : null,
    liveHealthPassed: checkOk('endpoint.health'),
  },
  evidence,
  checks,
  limits: [
    'This verifier checks GCP live metadata, IAM policies, and public endpoints. It does not read Secret Manager payload versions.',
    'Cloud KMS key material is non-exportable by design; this verifier confirms CI only sees key resource names and IAM policy metadata.',
    'A pass means the current deployed digest is attestation-gated for Secret Manager and app-level KMS access. It is not a formal proof of application correctness.',
  ],
}

await mkdir(outputDir, { recursive: true })
const jsonPath = join(outputDir, 'gcp-confidential-space-deployment-attestation.json')
const markdownPath = join(outputDir, 'gcp-confidential-space-deployment-attestation.md')
const checksumPath = `${jsonPath}.sha256`
const json = `${JSON.stringify(predicate, null, 2)}\n`
const checksum = createHash('sha256').update(json).digest('hex')

await writeFile(jsonPath, json, 'utf8')
await writeFile(checksumPath, `${checksum}  ${basename(jsonPath)}\n`, 'utf8')
await writeFile(markdownPath, renderMarkdown(predicate, checksum), 'utf8')

console.log(`attestation_result=${predicate.result}`)
console.log(`attestation_json=${jsonPath}`)
console.log(`attestation_markdown=${markdownPath}`)
console.log(`attestation_sha256=${checksum}`)

if (process.env.GITHUB_OUTPUT) {
  await writeFile(
    process.env.GITHUB_OUTPUT,
    [
      `attestation_result=${predicate.result}`,
      `attestation_json=${jsonPath}`,
      `attestation_markdown=${markdownPath}`,
      `attestation_sha256=${checksum}`,
      '',
    ].join('\n'),
    { flag: 'a' }
  )
}

if (failed.length > 0) {
  for (const check of failed) {
    console.error(`FAILED ${check.id}: ${check.detail}`)
  }
  process.exitCode = 1
}

async function discoverImageFromInstance() {
  const instance = await googleFetch(
    token,
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${instanceName}`,
    { allowNotFound: true }
  )
  const metadata = Object.fromEntries(
    (instance?.metadata?.items ?? []).map((item) => [item.key, item.value])
  )
  const discoveredReference = metadata['tee-image-reference']
  const discoveredDigest = parseImageDigest(discoveredReference)
  return {
    imageReference: discoveredReference,
    imageDigest: discoveredDigest,
  }
}

async function collectComputeEvidence() {
  const instance = await googleFetch(
    token,
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${instanceName}`,
    { allowNotFound: true }
  )
  expect('compute.instance_exists', Boolean(instance), `${instanceName} exists in ${zone}`)
  if (!instance) {
    return
  }

  const metadata = Object.fromEntries(
    (instance.metadata?.items ?? []).map((item) => [item.key, item.value])
  )
  const publicIp = firstPublicIp(instance)
  evidence.computeInstance = {
    name: instance.name,
    id: instance.id,
    status: instance.status,
    zone,
    publicIp,
    machineType: lastPathSegment(instance.machineType),
    confidentialInstanceConfig: instance.confidentialInstanceConfig ?? null,
    shieldedInstanceConfig: instance.shieldedInstanceConfig ?? null,
    serviceAccounts: (instance.serviceAccounts ?? []).map((account) => account.email),
    teeImageReference: metadata['tee-image-reference'] ?? null,
    teeEnvKeys: Object.keys(metadata)
      .filter((key) => key.startsWith('tee-env-'))
      .sort(),
    caddyStorageSecretResource: metadata['tee-env-CADDY_STORAGE_SECRET_RESOURCE'] ?? null,
  }

  expect(
    'compute.instance_running',
    instance.status === 'RUNNING',
    `instance status is ${instance.status}`
  )
  expect(
    'compute.image_reference_matches_digest',
    metadata['tee-image-reference'] === imageReference,
    'tee-image-reference matches the attested image reference'
  )
  expect(
    'compute.uses_runtime_service_account',
    (instance.serviceAccounts ?? []).some((account) => account.email === runtimeServiceAccount),
    `runtime service account is ${runtimeServiceAccount}`
  )
  expect(
    'compute.confidential_compute_enabled',
    instance.confidentialInstanceConfig?.enableConfidentialCompute === true,
    'Confidential Compute is enabled'
  )
  expect(
    'compute.confidential_instance_type_matches',
    instance.confidentialInstanceConfig?.confidentialInstanceType ===
      expectedConfidentialInstanceType,
    `Confidential Compute type is ${instance.confidentialInstanceConfig?.confidentialInstanceType}`
  )
  expect(
    'compute.shielded_vm_enabled',
    instance.shieldedInstanceConfig?.enableSecureBoot === true &&
      instance.shieldedInstanceConfig?.enableVtpm === true &&
      instance.shieldedInstanceConfig?.enableIntegrityMonitoring === true,
    'Shielded VM secure boot, vTPM, and integrity monitoring are enabled'
  )
  expect(
    'compute.metadata_contains_no_secret_payloads',
    !('tee-env-DB_PASSWORD' in metadata) &&
      !('tee-env-DATABASE_URL' in metadata) &&
      !('tee-env-MINT_SEED' in metadata) &&
      !('tee-env-MINT_PRIVATE_KEY' in metadata),
    'instance metadata does not contain DB password, DATABASE_URL, mint seed, or mint private key'
  )
  if (caddyAcmeStorageEnabled) {
    expect(
      'compute.caddy_storage_secret_metadata',
      metadata['tee-env-CADDY_STORAGE_SECRET_RESOURCE'] === caddyAcmeSecretResource,
      `Caddy ACME storage secret metadata points at ${caddyAcmeSecretResource}`
    )
  }
}

async function collectWorkloadIdentityEvidence() {
  const providerName =
    `projects/${projectNumber}/locations/global/workloadIdentityPools/${workloadIdentityPoolId}` +
    `/providers/${workloadIdentityProviderId}`
  const provider = await googleFetch(token, `https://iam.googleapis.com/v1/${providerName}`, {
    allowNotFound: true,
  })
  expect('wif.provider_exists', Boolean(provider), `${providerName} exists`)
  if (!provider) {
    return
  }

  const condition = provider.attributeCondition ?? ''
  evidence.workloadIdentityProvider = {
    name: provider.name,
    state: provider.state,
    issuerUri: provider.oidc?.issuerUri ?? null,
    allowedAudiences: provider.oidc?.allowedAudiences ?? [],
    attributeMapping: provider.attributeMapping ?? {},
    attributeCondition: condition,
  }

  expect('wif.provider_enabled', provider.state === 'ACTIVE', `provider state is ${provider.state}`)
  expect(
    'wif.condition_requires_digest',
    condition.includes(`assertion.submods.container.image_digest == '${imageDigest}'`),
    'provider condition pins the expected container image digest'
  )
  expect(
    'wif.condition_requires_service_account',
    condition.includes(runtimeServiceAccount),
    'provider condition requires the expected VM service account'
  )
  expect(
    'wif.condition_requires_confidential_space',
    condition.includes("assertion.swname == 'CONFIDENTIAL_SPACE'"),
    'provider condition requires CONFIDENTIAL_SPACE'
  )
  expect(
    'wif.condition_requires_stable_image',
    condition.includes("'STABLE' in assertion.submods.confidential_space.support_attributes"),
    'provider condition requires the STABLE support attribute'
  )
  expect(
    'wif.condition_requires_production_image',
    condition.includes("assertion.dbgstat == 'disabled-since-boot'"),
    'provider condition requires production Confidential Space image debugging to be disabled'
  )
}

async function collectIamEvidence() {
  const [kmsPolicy, secretPolicy, projectPolicy] = await Promise.all([
    getIamPolicy(`https://cloudkms.googleapis.com/v1/${appKmsKeyName}:getIamPolicy`, 'GET'),
    getIamPolicy(`https://secretmanager.googleapis.com/v1/${secretResource}:getIamPolicy`, 'GET'),
    getIamPolicy(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`
    ),
  ])

  evidence.appKmsIam = summarizePolicy(kmsPolicy)
  evidence.secretManagerIam = summarizePolicy(secretPolicy)
  evidence.projectIamRuntimeServiceAccountBindings = summarizeMemberRoles(
    projectPolicy,
    `serviceAccount:${runtimeServiceAccount}`
  )

  const kmsDigestMembers = digestPrincipals(kmsPolicy)
  const secretDigestMembers = digestPrincipals(secretPolicy)

  expect(
    'kms.current_digest_principal_has_decrypt',
    membersFor(kmsPolicy, 'roles/cloudkms.cryptoKeyEncrypterDecrypter').includes(
      confidentialSpacePrincipal
    ),
    'app KMS EncrypterDecrypter role includes the current attested digest principal'
  )
  expect(
    'kms.no_stale_digest_principals',
    kmsDigestMembers.every((member) => member === confidentialSpacePrincipal),
    `unexpected app KMS digest principals: ${kmsDigestMembers.filter((member) => member !== confidentialSpacePrincipal).join(', ') || 'none'}`
  )
  expect(
    'kms.runtime_service_account_has_no_direct_access',
    !policyHasMemberInRoles(kmsPolicy, `serviceAccount:${runtimeServiceAccount}`, [
      'roles/cloudkms.admin',
      'roles/cloudkms.cryptoKeyDecrypter',
      'roles/cloudkms.cryptoKeyEncrypterDecrypter',
    ]) &&
      !policyHasMemberInRoles(projectPolicy, `serviceAccount:${runtimeServiceAccount}`, [
        'roles/owner',
        'roles/editor',
        'roles/cloudkms.admin',
        'roles/cloudkms.cryptoKeyDecrypter',
        'roles/cloudkms.cryptoKeyEncrypterDecrypter',
      ]),
    'runtime service account has no direct project-level or key-level app KMS decrypt role'
  )
  expect(
    'kms.no_public_members',
    !policyHasPublicMember(kmsPolicy),
    'app KMS IAM policy has no allUsers/allAuthenticatedUsers member'
  )

  expect(
    'secret.current_digest_principal_has_access',
    membersFor(secretPolicy, 'roles/secretmanager.secretAccessor').includes(
      confidentialSpacePrincipal
    ),
    'Secret Manager accessor role includes the attested digest principal'
  )
  expect(
    'secret.no_stale_digest_principals',
    secretDigestMembers.every((member) => member === confidentialSpacePrincipal),
    `unexpected Secret Manager digest principals: ${secretDigestMembers.filter((member) => member !== confidentialSpacePrincipal).join(', ') || 'none'}`
  )
  expect(
    'secret.runtime_service_account_has_no_direct_access',
    !policyHasMemberInRoles(secretPolicy, `serviceAccount:${runtimeServiceAccount}`, [
      'roles/secretmanager.admin',
      'roles/secretmanager.secretAccessor',
    ]) &&
      !policyHasMemberInRoles(projectPolicy, `serviceAccount:${runtimeServiceAccount}`, [
        'roles/owner',
        'roles/editor',
        'roles/secretmanager.admin',
        'roles/secretmanager.secretAccessor',
      ]),
    'runtime service account has no direct project-level or secret-level Secret Manager accessor role'
  )
  expect(
    'secret.no_public_members',
    !policyHasPublicMember(secretPolicy),
    'Secret Manager IAM policy has no allUsers/allAuthenticatedUsers member'
  )
}

async function collectSecretEvidence() {
  const secret = await googleFetch(
    token,
    `https://secretmanager.googleapis.com/v1/${secretResource}`
  )
  const kmsKeys = secretKmsKeys(secret)
  evidence.secretManagerSecret = {
    name: secret.name,
    replicationKmsKeys: kmsKeys,
  }

  expect(
    'secret.cmek_configured',
    kmsKeys.includes(secretManagerKmsKeyName),
    `Secret Manager secret uses expected CMEK ${secretManagerKmsKeyName}`
  )
}

async function collectCaddyAcmeStorageEvidence() {
  const [secret, secretPolicy, versions] = await Promise.all([
    googleFetch(token, `https://secretmanager.googleapis.com/v1/${caddyAcmeSecretResource}`, {
      allowNotFound: true,
    }),
    getIamPolicy(
      `https://secretmanager.googleapis.com/v1/${caddyAcmeSecretResource}:getIamPolicy`,
      'GET'
    ).catch(() => null),
    googleFetch(
      token,
      `https://secretmanager.googleapis.com/v1/${caddyAcmeSecretResource}/versions?pageSize=10`,
      {
        allowNotFound: true,
      }
    ).catch(() => null),
  ])

  const kmsKeys = secret ? secretKmsKeys(secret) : []
  const digestMembers = secretPolicy ? digestPrincipals(secretPolicy) : []

  evidence.caddyAcmeStorage = {
    secret: secret
      ? {
          name: secret.name,
          replicationKmsKeys: kmsKeys,
        }
      : null,
    versions: {
      countInFirstPage: versions?.versions?.length ?? 0,
      states: (versions?.versions ?? []).map((version) => version.state),
    },
    iam: secretPolicy ? summarizePolicy(secretPolicy) : null,
  }

  expect('caddy_acme.secret_exists', Boolean(secret), `${caddyAcmeSecretResource} exists`)
  if (secret) {
    expect(
      'caddy_acme.cmek_configured',
      kmsKeys.includes(secretManagerKmsKeyName),
      `Caddy ACME storage secret uses expected CMEK ${secretManagerKmsKeyName}`
    )
  }

  expect(
    'caddy_acme.current_digest_principal_can_access',
    Boolean(secretPolicy) &&
      membersFor(secretPolicy, 'roles/secretmanager.secretAccessor').includes(
        confidentialSpacePrincipal
      ),
    'Caddy ACME storage secret accessor role includes the attested digest principal'
  )
  expect(
    'caddy_acme.current_digest_principal_can_add_versions',
    Boolean(secretPolicy) &&
      membersFor(secretPolicy, 'roles/secretmanager.secretVersionAdder').includes(
        confidentialSpacePrincipal
      ),
    'Caddy ACME storage secretVersionAdder role includes the attested digest principal'
  )
  expect(
    'caddy_acme.no_stale_digest_principals',
    digestMembers.every((member) => member === confidentialSpacePrincipal),
    `unexpected Caddy ACME digest principals: ${digestMembers.filter((member) => member !== confidentialSpacePrincipal).join(', ') || 'none'}`
  )
  expect(
    'caddy_acme.runtime_service_account_has_no_direct_access',
    Boolean(secretPolicy) &&
      !policyHasMemberInRoles(secretPolicy, `serviceAccount:${runtimeServiceAccount}`, [
        'roles/secretmanager.admin',
        'roles/secretmanager.secretAccessor',
        'roles/secretmanager.secretVersionAdder',
      ]),
    'runtime service account has no direct Caddy ACME storage secret access'
  )
  expect(
    'caddy_acme.no_public_members',
    Boolean(secretPolicy) && !policyHasPublicMember(secretPolicy),
    'Caddy ACME storage secret IAM policy has no allUsers/allAuthenticatedUsers member'
  )
}

async function collectCloudSqlEvidence() {
  const instance = await googleFetch(
    token,
    `https://sqladmin.googleapis.com/sql/v1beta4/projects/${projectId}/instances/${namePrefix}-postgres`,
    { allowNotFound: true }
  )
  expect('cloudsql.instance_exists', Boolean(instance), `${namePrefix}-postgres exists`)
  if (!instance) {
    return
  }

  evidence.cloudSql = {
    name: instance.name,
    region: instance.region,
    databaseVersion: instance.databaseVersion,
    state: instance.state,
    ipAddressTypes: (instance.ipAddresses ?? []).map((item) => item.type),
    diskEncryptionConfiguration: instance.diskEncryptionConfiguration ?? null,
  }

  expect(
    'cloudsql.instance_runnable',
    instance.state === 'RUNNABLE',
    `Cloud SQL state is ${instance.state}`
  )
  expect(
    'cloudsql.private_ip_only',
    (instance.ipAddresses ?? []).some((item) => item.type === 'PRIVATE') &&
      !(instance.ipAddresses ?? []).some((item) => item.type === 'PRIMARY'),
    'Cloud SQL has private IP and no public PRIMARY IP'
  )
  expect(
    'cloudsql.cmek_configured',
    instance.diskEncryptionConfiguration?.kmsKeyName === appKmsKeyName,
    `Cloud SQL uses expected CMEK ${appKmsKeyName}`
  )
}

async function collectAuditMonitoringEvidence() {
  const [bucket, sink, policies, projectPolicy] = await Promise.all([
    googleFetch(token, `https://storage.googleapis.com/storage/v1/b/${auditLogArchiveBucketName}`, {
      allowNotFound: true,
    }),
    googleFetch(
      token,
      `https://logging.googleapis.com/v2/projects/${projectId}/sinks/${namePrefix}-security-audit-archive`,
      { allowNotFound: true }
    ),
    googleFetch(
      token,
      `https://monitoring.googleapis.com/v3/projects/${projectId}/alertPolicies?pageSize=100`
    ),
    getIamPolicy(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`
    ),
  ])
  const alertPolicy = (policies.alertPolicies ?? []).find(
    (policy) => policy.displayName === `${namePrefix} sensitive admin audit activity`
  )

  evidence.auditMonitoring = {
    archiveBucket: bucket
      ? {
          name: bucket.name,
          location: bucket.location,
          retentionPolicy: bucket.retentionPolicy ?? null,
          iamConfiguration: bucket.iamConfiguration ?? null,
        }
      : null,
    archiveSink: sink
      ? {
          name: sink.name,
          destination: sink.destination,
          filter: sink.filter,
          writerIdentity: sink.writerIdentity,
        }
      : null,
    alertPolicy: alertPolicy
      ? {
          name: alertPolicy.name,
          displayName: alertPolicy.displayName,
          enabled: alertPolicy.enabled,
          notificationChannels: alertPolicy.notificationChannels ?? [],
        }
      : null,
    auditConfigs: projectPolicy.auditConfigs ?? [],
  }

  expect('audit.archive_bucket_exists', Boolean(bucket), `${auditLogArchiveBucketName} exists`)
  if (bucket) {
    expect(
      'audit.archive_bucket_public_access_prevention',
      bucket.iamConfiguration?.publicAccessPrevention === 'enforced',
      'audit archive bucket enforces public access prevention'
    )
    expect(
      'audit.archive_bucket_retention_configured',
      Number(bucket.retentionPolicy?.retentionPeriod ?? 0) > 0,
      'audit archive bucket has retention configured'
    )
  }

  expect('audit.archive_sink_exists', Boolean(sink), `${namePrefix}-security-audit-archive exists`)
  if (sink) {
    expect(
      'audit.archive_sink_routes_cloud_audit_logs',
      sink.filter?.includes('cloudaudit.googleapis.com/activity') === true,
      'audit archive sink routes Admin Activity audit logs'
    )
  }

  expect(
    'audit.alert_policy_exists',
    Boolean(alertPolicy),
    'sensitive admin audit activity alert policy exists'
  )
  if (alertPolicy) {
    expect(
      'audit.alert_policy_enabled',
      alertPolicy.enabled !== false,
      'audit alert policy is enabled'
    )
    const conditionFilter = alertPolicy.conditions?.[0]?.conditionMatchedLog?.filter ?? ''
    expect(
      'audit.alert_policy_matches_iam_changes',
      conditionFilter.includes('SetIamPolicy'),
      'audit alert policy matches SetIamPolicy changes'
    )
  }

  if (auditDataAccessLogsEnabled) {
    expect(
      'audit.kms_data_access_logs_enabled',
      serviceAuditConfigHas(projectPolicy, 'cloudkms.googleapis.com', ['DATA_READ', 'DATA_WRITE']),
      'Cloud KMS DATA_READ and DATA_WRITE audit logs are enabled'
    )
    expect(
      'audit.secretmanager_data_access_logs_enabled',
      serviceAuditConfigHas(projectPolicy, 'secretmanager.googleapis.com', [
        'DATA_READ',
        'DATA_WRITE',
      ]),
      'Secret Manager DATA_READ and DATA_WRITE audit logs are enabled'
    )
  }
}

async function collectEndpointEvidence() {
  const baseUrl = `https://${domainName}`
  const [health, info, cors] = await Promise.all([
    fetchJson(`${baseUrl}/health`),
    fetchJson(`${baseUrl}/v1/info`),
    fetchRaw(`${baseUrl}/v1/info`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://wallet.cashu.me',
        'Access-Control-Request-Method': 'GET',
      },
    }),
  ])

  const dnsRecords = await resolve4(domainName).catch(() => [])
  const publicIp = evidence.computeInstance?.publicIp

  evidence.endpoints = {
    baseUrl,
    dnsA: dnsRecords,
    healthStatus: health.status,
    infoStatus: info.status,
    corsStatus: cors.status,
    healthHeaders: headerSubset(health.headers, ['via', 'cf-ray', 'server', 'alt-svc']),
    infoHeaders: headerSubset(info.headers, [
      'via',
      'cf-ray',
      'server',
      'access-control-allow-origin',
    ]),
    corsHeaders: headerSubset(cors.headers, [
      'access-control-allow-origin',
      'access-control-allow-methods',
    ]),
  }

  expect(
    'endpoint.dns_points_to_instance',
    dnsRecords.includes(publicIp),
    `${domainName} resolves to ${publicIp}`
  )
  expect('endpoint.health', health.status === 200 && health.json, '/health returns 200 JSON')
  expect('endpoint.info', info.status === 200 && info.json, '/v1/info returns 200 JSON')
  expect(
    'endpoint.cors_cashu_wallet',
    [200, 204].includes(cors.status) &&
      ['https://wallet.cashu.me', '*'].includes(
        cors.headers.get('access-control-allow-origin') ?? ''
      ),
    'OPTIONS /v1/info allows https://wallet.cashu.me'
  )
  expect(
    'endpoint.tls_direct_to_caddy',
    (health.headers.get('via') ?? '').includes('Caddy') && !health.headers.has('cf-ray'),
    'public HTTPS response is served directly by Caddy, with no Cloudflare TLS hop observed'
  )
}

function expect(id, ok, detail, required = true) {
  checks.push({
    id,
    ok: Boolean(ok),
    required,
    detail,
  })
}

function checkOk(id) {
  return checks.find((check) => check.id === id)?.ok === true
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      throw new Error(`Unexpected argument: ${item}`)
    }

    const key = item.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true'
      continue
    }

    parsed[key] = next
    index += 1
  }
  return parsed
}

async function readTfvars(path) {
  try {
    const content = await readFile(path, 'utf8')
    const values = {}
    for (const line of content.split(/\r?\n/)) {
      const stringMatch = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/)
      if (stringMatch) {
        values[stringMatch[1]] = stringMatch[2]
        continue
      }

      const boolMatch = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(true|false)\s*(?:#.*)?$/)
      if (boolMatch) {
        values[boolMatch[1]] = boolMatch[2] === 'true'
        continue
      }

      const numberMatch = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*([0-9]+)\s*(?:#.*)?$/)
      if (numberMatch) {
        values[numberMatch[1]] = Number(numberMatch[2])
      }
    }
    return values
  } catch {
    return {}
  }
}

function required(value, message) {
  if (!value) {
    throw new Error(message)
  }
  return value
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value
  }
  return String(value).toLowerCase() === 'true'
}

async function getAccessToken() {
  const ambientToken =
    process.env.GCP_ACCESS_TOKEN ??
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN ??
    process.env.CLOUDSDK_AUTH_ACCESS_TOKEN
  if (ambientToken) {
    return ambientToken
  }

  const credentialsPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ??
    join(homedir(), '.config/gcloud/application_default_credentials.json')
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'))

  if (credentials.type === 'authorized_user') {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
        grant_type: 'refresh_token',
      }),
    })

    if (!response.ok) {
      throw new Error(`OAuth refresh failed: ${response.status} ${await response.text()}`)
    }

    const payload = await response.json()
    return payload.access_token
  }

  if (credentials.type === 'service_account') {
    const now = Math.floor(Date.now() / 1000)
    const assertion = signJwt(
      {
        alg: 'RS256',
        typ: 'JWT',
      },
      {
        iss: credentials.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      },
      credentials.private_key
    )
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    })

    if (!response.ok) {
      throw new Error(
        `Service account token exchange failed: ${response.status} ${await response.text()}`
      )
    }

    const payload = await response.json()
    return payload.access_token
  }

  if (credentials.credential_source || credentials.subject_token_type) {
    throw new Error(
      'External account ADC is not supported by this script yet. Use google-github-actions/auth with create_credentials_file=true and token_format=access_token, or provide a service account JSON.'
    )
  }

  throw new Error(`Unsupported ADC credential type: ${credentials.type ?? 'unknown'}`)
}

function signJwt(header, payload, privateKey) {
  const encodedHeader = base64Url(JSON.stringify(header))
  const encodedPayload = base64Url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  return `${signingInput}.${base64Url(signer.sign(privateKey))}`
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function googleFetch(accessToken, url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (options.allowNotFound && response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${url} failed: ${response.status} ${await response.text()}`
    )
  }

  if (response.status === 204) {
    return null
  }

  return response.json()
}

function getIamPolicy(url, method = 'POST') {
  return googleFetch(token, url, {
    method,
    body: method === 'POST' ? {} : undefined,
  })
}

async function fetchRaw(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetchRaw(url, options)
  const contentType = response.headers.get('content-type') ?? ''
  let json = null
  if (contentType.includes('application/json')) {
    json = await response.json().catch(() => null)
  }
  return {
    status: response.status,
    headers: response.headers,
    json,
  }
}

function membersFor(policy, role) {
  return policy.bindings?.find((binding) => binding.role === role)?.members ?? []
}

function digestPrincipals(policy) {
  return [
    ...new Set(
      (policy.bindings ?? [])
        .flatMap((binding) => binding.members ?? [])
        .filter((member) => member.startsWith(digestPrincipalPrefix))
    ),
  ].sort()
}

function policyHasMemberInRoles(policy, member, roles) {
  return (policy.bindings ?? []).some(
    (binding) => roles.includes(binding.role) && (binding.members ?? []).includes(member)
  )
}

function policyHasPublicMember(policy) {
  return (policy.bindings ?? []).some((binding) =>
    (binding.members ?? []).some(
      (member) => member === 'allUsers' || member === 'allAuthenticatedUsers'
    )
  )
}

function summarizePolicy(policy) {
  return {
    etag: policy.etag ?? null,
    bindings: (policy.bindings ?? []).map((binding) => ({
      role: binding.role,
      members: [...(binding.members ?? [])].sort(),
    })),
  }
}

function summarizeMemberRoles(policy, member) {
  return (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => binding.role)
    .sort()
}

function secretKmsKeys(secret) {
  const keys = []
  const automatic = secret.replication?.automatic?.customerManagedEncryption?.kmsKeyName
  if (automatic) {
    keys.push(automatic)
  }

  for (const replica of secret.replication?.userManaged?.replicas ?? []) {
    const key = replica.customerManagedEncryption?.kmsKeyName
    if (key) {
      keys.push(key)
    }
  }

  return [...new Set(keys)].sort()
}

function serviceAuditConfigHas(policy, service, logTypes) {
  const config = (policy.auditConfigs ?? []).find((candidate) => candidate.service === service)
  const enabled = new Set((config?.auditLogConfigs ?? []).map((item) => item.logType))
  return logTypes.every((logType) => enabled.has(logType))
}

function firstPublicIp(instance) {
  for (const networkInterface of instance.networkInterfaces ?? []) {
    for (const accessConfig of networkInterface.accessConfigs ?? []) {
      if (accessConfig.natIP) {
        return accessConfig.natIP
      }
    }
  }
  return null
}

function lastPathSegment(value) {
  return typeof value === 'string' ? value.split('/').at(-1) : value
}

function parseImageDigest(reference) {
  const match = String(reference ?? '').match(/@(sha256:[a-f0-9]{64})$/)
  return match?.[1] ?? ''
}

function headerSubset(headers, names) {
  return Object.fromEntries(
    names.map((name) => [name, headers.get(name)]).filter(([, value]) => value !== null)
  )
}

function githubContext() {
  return {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    ref: process.env.GITHUB_REF ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    actor: process.env.GITHUB_ACTOR ?? null,
  }
}

function renderMarkdown(predicate, checksum) {
  const failed = predicate.checks.filter((check) => check.required && !check.ok)
  const rows = predicate.checks
    .map(
      (check) =>
        `| ${check.ok ? 'PASS' : 'FAIL'} | \`${check.id}\` | ${escapeTable(check.detail)} |`
    )
    .join('\n')

  return `# GCP Confidential Space Deployment Attestation

Result: **${predicate.result.toUpperCase()}**

Image: \`${predicate.subject.imageReference}\`

Digest: \`${predicate.subject.imageDigest}\`

Target: \`${predicate.target.domainName}\` in \`${predicate.target.projectId}/${predicate.target.zone}\`

Runtime service account: \`${predicate.target.runtimeServiceAccount}\`

Attestation JSON SHA-256: \`${checksum}\`

## Key Handling Claims

- The verifier did not read Secret Manager payload versions.
- The verifier did not call Cloud KMS encrypt or decrypt.
- Cloud KMS key material is not exported to CI; CI observes only key resource names and IAM policy metadata.
- App KMS and Secret Manager access are granted to the attested image digest principal, not directly to the VM service account.
- Caddy ACME storage, when enabled, is persisted through a separate CMEK-protected Secret Manager secret with digest-bound access and version-add permissions.

## Checks

| Status | Check | Detail |
| --- | --- | --- |
${rows}

${failed.length === 0 ? 'All required checks passed.' : `Failed required checks: ${failed.map((check) => `\`${check.id}\``).join(', ')}`}
`
}

function escapeTable(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
