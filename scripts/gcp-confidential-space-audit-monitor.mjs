#!/usr/bin/env node
import { createHash, createSign } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = parseArgs(process.argv.slice(2))
const projectId = required(
  args.project ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT,
  'GCP project is required. Pass --project or set GCP_PROJECT_ID.'
)
const environment =
  args.environment ?? process.env.ENVIRONMENT_NAME ?? process.env.TF_VAR_environment ?? 'prod'
const namePrefix = args['name-prefix'] ?? `ducat-mint-${environment}`
const lookbackMinutes = Number(
  args['lookback-minutes'] ?? process.env.AUDIT_LOOKBACK_MINUTES ?? 1440
)
const outputDir = resolve(repoRoot, args['output-dir'] ?? 'audit-monitor')
const baselineTime = args.since ?? process.env.AUDIT_BASELINE_TIME ?? ''
const allowedPrincipals = unique([
  ...arrayArg(args['allowed-principal']),
  ...(process.env.GCP_DEPLOY_SERVICE_ACCOUNT ? [process.env.GCP_DEPLOY_SERVICE_ACCOUNT] : []),
  ...(process.env.AUDIT_ALLOWED_PRINCIPALS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
])
const failOnFindings = parseBoolean(
  args['fail-on-findings'] ?? process.env.AUDIT_FAIL_ON_FINDINGS ?? true
)

const token = await getAccessToken()
const lookbackSince = new Date(Date.now() - lookbackMinutes * 60 * 1000)
const sinceDate = baselineTime ? maxDate(lookbackSince, new Date(baselineTime)) : lookbackSince
const since = sinceDate.toISOString()
const events = await listSensitiveAdminEvents(since)
const unexpectedEvents = events.filter((event) => !allowedPrincipals.includes(event.principalEmail))

const predicate = {
  predicateType: 'https://ducatprotocol.com/attestations/gcp-confidential-space-audit-monitor/v1',
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  result: unexpectedEvents.length === 0 ? 'pass' : 'fail',
  target: {
    projectId,
    environment,
    namePrefix,
  },
  window: {
    since,
    lookbackMinutes,
    baselineTime: baselineTime || null,
  },
  policy: {
    allowedPrincipals,
    failOnFindings,
  },
  summary: {
    sensitiveAdminEvents: events.length,
    unexpectedSensitiveAdminEvents: unexpectedEvents.length,
  },
  unexpectedEvents,
}

await mkdir(outputDir, { recursive: true })
const jsonPath = join(outputDir, 'gcp-confidential-space-audit-monitor.json')
const markdownPath = join(outputDir, 'gcp-confidential-space-audit-monitor.md')
const checksumPath = `${jsonPath}.sha256`
const json = `${JSON.stringify(predicate, null, 2)}\n`
const checksum = createHash('sha256').update(json).digest('hex')

await writeFile(jsonPath, json, 'utf8')
await writeFile(checksumPath, `${checksum}  ${basename(jsonPath)}\n`, 'utf8')
await writeFile(markdownPath, renderMarkdown(predicate, checksum), 'utf8')

console.log(`audit_monitor_result=${predicate.result}`)
console.log(`audit_monitor_json=${jsonPath}`)
console.log(`audit_monitor_markdown=${markdownPath}`)
console.log(`audit_monitor_sha256=${checksum}`)

if (process.env.GITHUB_OUTPUT) {
  await writeFile(
    process.env.GITHUB_OUTPUT,
    [
      `audit_monitor_result=${predicate.result}`,
      `audit_monitor_json=${jsonPath}`,
      `audit_monitor_markdown=${markdownPath}`,
      `audit_monitor_sha256=${checksum}`,
      '',
    ].join('\n'),
    { flag: 'a' }
  )
}

if (unexpectedEvents.length > 0) {
  for (const event of unexpectedEvents.slice(0, 20)) {
    console.error(
      `UNEXPECTED ${event.timestamp} ${event.methodName} ${event.principalEmail || 'unknown-principal'} ${event.resourceName}`
    )
  }
  if (failOnFindings) {
    process.exitCode = 1
  }
}

async function listSensitiveAdminEvents(sinceTimestamp) {
  const filter = [
    'log_id("cloudaudit.googleapis.com/activity")',
    `timestamp >= "${sinceTimestamp}"`,
    sensitiveMethodFilter(),
  ].join(' AND ')

  const entries = []
  let pageToken = ''
  do {
    const response = await googleFetch(token, 'https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      body: {
        resourceNames: [`projects/${projectId}`],
        filter,
        orderBy: 'timestamp desc',
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      },
    })

    entries.push(...(response.entries ?? []))
    pageToken = response.nextPageToken ?? ''
  } while (pageToken)

  return entries.map((entry) => ({
    timestamp: entry.timestamp,
    insertId: entry.insertId,
    logName: entry.logName,
    principalEmail: entry.protoPayload?.authenticationInfo?.principalEmail ?? '',
    serviceName: entry.protoPayload?.serviceName ?? '',
    methodName: entry.protoPayload?.methodName ?? '',
    resourceName: entry.protoPayload?.resourceName ?? '',
  }))
}

function sensitiveMethodFilter() {
  const methods = [
    'SetIamPolicy',
    'CreateWorkloadIdentityPool',
    'UpdateWorkloadIdentityPool',
    'DeleteWorkloadIdentityPool',
    'CreateWorkloadIdentityPoolProvider',
    'UpdateWorkloadIdentityPoolProvider',
    'DeleteWorkloadIdentityPoolProvider',
    'UpdateCryptoKey',
    'DestroyCryptoKeyVersion',
    'RestoreCryptoKeyVersion',
    'UpdateSecret',
    'AddSecretVersion',
    'DestroySecretVersion',
    'DisableSecretVersion',
    'EnableSecretVersion',
    'instances.insert',
    'instances.delete',
    'instances.setMetadata',
    'instances.setServiceAccount',
    'instances.stop',
    'instances.start',
    'sql.instances.update',
    'CreateServiceAccountKey',
  ]
  return `(${methods.map((method) => `protoPayload.methodName:"${method}"`).join(' OR ')})`
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
    return (await response.json()).access_token
  }

  if (credentials.type === 'service_account') {
    const now = Math.floor(Date.now() / 1000)
    const assertion = signJwt(
      { alg: 'RS256', typ: 'JWT' },
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
    return (await response.json()).access_token
  }

  throw new Error(`Unsupported ADC credential type: ${credentials.type ?? 'unknown'}`)
}

function signJwt(header, payload, privateKey) {
  const encodedHeader = base64Url(JSON.stringify(header))
  const encodedPayload = base64Url(JSON.stringify(payload))
  const signer = createSign('RSA-SHA256')
  signer.update(`${encodedHeader}.${encodedPayload}`)
  signer.end()
  return `${encodedHeader}.${encodedPayload}.${base64Url(signer.sign(privateKey))}`
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

  if (!response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${url} failed: ${response.status} ${await response.text()}`
    )
  }
  return response.status === 204 ? null : response.json()
}

function renderMarkdown(predicate, checksum) {
  const rows = predicate.unexpectedEvents
    .map(
      (event) =>
        `| ${event.timestamp} | ${escapeTable(event.principalEmail || 'unknown')} | ${escapeTable(event.methodName)} | ${escapeTable(event.resourceName)} |`
    )
    .join('\n')

  return `# GCP Confidential Space Audit Monitor

Result: **${predicate.result.toUpperCase()}**

Project: \`${predicate.target.projectId}\`

Environment: \`${predicate.target.environment}\`

Window: since \`${predicate.window.since}\` (${predicate.window.lookbackMinutes} minutes)

Audit monitor JSON SHA-256: \`${checksum}\`

Sensitive admin events: \`${predicate.summary.sensitiveAdminEvents}\`

Unexpected sensitive admin events: \`${predicate.summary.unexpectedSensitiveAdminEvents}\`

Allowed principals:

${predicate.policy.allowedPrincipals.map((principal) => `- \`${principal}\``).join('\n') || '- none'}

## Unexpected Events

| Timestamp | Principal | Method | Resource |
| --- | --- | --- | --- |
${rows || '| none | none | none | none |'}
`
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
    const value = !next || next.startsWith('--') ? 'true' : next
    if (parsed[key] === undefined) {
      parsed[key] = value
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(value)
    } else {
      parsed[key] = [parsed[key], value]
    }
    if (value === next) {
      index += 1
    }
  }
  return parsed
}

function arrayArg(value) {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value
  }
  return String(value).toLowerCase() === 'true'
}

function required(value, message) {
  if (!value) {
    throw new Error(message)
  }
  return value
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function maxDate(left, right) {
  if (Number.isNaN(right.getTime())) {
    throw new Error(`Invalid audit baseline timestamp: ${baselineTime}`)
  }
  return left > right ? left : right
}

function escapeTable(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
