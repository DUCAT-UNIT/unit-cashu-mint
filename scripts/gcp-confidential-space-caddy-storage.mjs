#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
const storagePath = args.path ?? process.env.CADDY_STORAGE_PATH ?? '/data/caddy'
const secretResource = args.secret ?? process.env.CADDY_STORAGE_SECRET_RESOURCE
const intervalSeconds = Number(
  args.interval ?? process.env.CADDY_STORAGE_SYNC_INTERVAL_SECONDS ?? 60
)
const maxBytes = Number(args['max-bytes'] ?? process.env.CADDY_STORAGE_MAX_BYTES ?? 60000)

if (!['restore', 'snapshot', 'watch'].includes(command)) {
  throw new Error(
    'Usage: gcp-confidential-space-caddy-storage.mjs <restore|snapshot|watch> --secret <resource> [--path /data/caddy]'
  )
}

if (!secretResource) {
  throw new Error('CADDY_STORAGE_SECRET_RESOURCE or --secret is required')
}

if (command === 'restore') {
  await restore()
} else if (command === 'snapshot') {
  await snapshot()
} else {
  await watch()
}

async function restore() {
  const accessToken = await getAccessToken()
  const archive = await accessLatestSecretVersion(accessToken, secretResource)
  if (!archive) {
    console.log(
      `No Caddy ACME storage version exists for ${secretResource}; Caddy will issue a fresh certificate if needed.`
    )
    return
  }

  await mkdir(storagePath, { recursive: true, mode: 0o700 })
  const tempDir = await mkdtemp(join(tmpdir(), 'ducat-caddy-restore-'))
  const archivePath = join(tempDir, 'caddy-storage.tgz')
  try {
    await writeFile(archivePath, archive)
    run('tar', ['-C', storagePath, '-xzf', archivePath])
    console.log(`Restored Caddy ACME storage from ${secretResource}.`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function snapshot() {
  const archived = await archiveStorage()
  if (!archived) {
    console.log(`No Caddy ACME storage files found at ${storagePath}; skipping snapshot.`)
    return
  }

  if (archived.length > maxBytes) {
    throw new Error(
      `Caddy ACME storage archive is ${archived.length} bytes, above the configured ${maxBytes} byte Secret Manager payload limit.`
    )
  }

  const accessToken = await getAccessToken()
  const latest = await accessLatestSecretVersion(accessToken, secretResource)
  const nextHash = sha256(archived)
  const latestHash = latest ? sha256(latest) : null

  if (latestHash === nextHash) {
    console.log(`Caddy ACME storage is unchanged (${nextHash}).`)
    return
  }

  await addSecretVersion(accessToken, secretResource, archived)
  console.log(`Persisted Caddy ACME storage to ${secretResource} (${nextHash}).`)
}

async function watch() {
  console.log(`Watching ${storagePath} for Caddy ACME storage snapshots every ${intervalSeconds}s.`)
  while (true) {
    try {
      await snapshot()
    } catch (error) {
      console.error(`Caddy ACME storage snapshot failed: ${error.message}`)
    }
    await sleep(intervalSeconds * 1000)
  }
}

async function archiveStorage() {
  if (!existsSync(storagePath) || !(await hasAnyFile(storagePath))) {
    return null
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'ducat-caddy-snapshot-'))
  const archivePath = join(tempDir, 'caddy-storage.tgz')
  try {
    run('tar', ['-C', storagePath, '-czf', archivePath, '.'])
    return await readFile(archivePath)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function hasAnyFile(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isFile()) {
      return true
    }
    if (entry.isDirectory() && (await hasAnyFile(child))) {
      return true
    }
  }
  return false
}

async function getAccessToken() {
  const subjectToken = await getConfidentialSpaceToken()
  const response = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: required(
        process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE,
        'GCP_WORKLOAD_IDENTITY_AUDIENCE is required'
      ),
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      subjectToken,
    }),
  })

  if (!response.ok) {
    throw new Error(`STS token exchange failed: ${response.status} ${await response.text()}`)
  }

  const payload = await response.json()
  if (!payload.access_token) {
    throw new Error('STS response did not include access_token')
  }
  return payload.access_token
}

async function getConfidentialSpaceToken() {
  const tokenSocket =
    process.env.CONFIDENTIAL_SPACE_TOKEN_SOCKET ?? '/run/container_launcher/teeserver.sock'
  const body = JSON.stringify({
    audience: process.env.GCP_ATTESTATION_TOKEN_AUDIENCE ?? 'https://sts.googleapis.com',
    token_type: 'OIDC',
  })
  const responseBody = await unixSocketPost(tokenSocket, '/v1/token', body)
  const token = extractToken(responseBody)
  if (!token.includes('.')) {
    throw new Error('Confidential Space token endpoint returned a non-JWT token')
  }
  return token
}

async function accessLatestSecretVersion(accessToken, resource) {
  const response = await fetch(
    `https://secretmanager.googleapis.com/v1/${normalizeSecretResource(resource)}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )

  if (response.status === 404 || response.status === 400) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Secret Manager access failed: ${response.status} ${await response.text()}`)
  }

  const payload = await response.json()
  const encoded = payload?.payload?.data
  return encoded ? Buffer.from(encoded, 'base64') : null
}

async function addSecretVersion(accessToken, resource, data) {
  const response = await fetch(
    `https://secretmanager.googleapis.com/v1/${normalizeSecretResource(resource)}:addVersion`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payload: {
          data: data.toString('base64'),
        },
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`Secret Manager addVersion failed: ${response.status} ${await response.text()}`)
  }
}

function normalizeSecretResource(resource) {
  if (resource.startsWith('projects/')) {
    return resource.replace(/\/versions\/.*$/, '')
  }

  const projectId = required(
    process.env.GCP_PROJECT_ID,
    'GCP_PROJECT_ID is required when secret is not fully qualified'
  )
  return `projects/${projectId}/secrets/${resource}`
}

function unixSocketPost(socketPath, path, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: {
          Host: 'localhost',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8').trim()
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `Confidential Space token endpoint failed: ${response.statusCode} ${responseBody}`
              )
            )
            return
          }
          resolve(responseBody)
        })
      }
    )

    request.on('error', reject)
    request.write(body)
    request.end()
  })
}

function extractToken(responseBody) {
  try {
    const parsed = JSON.parse(responseBody)
    if (typeof parsed === 'string') {
      return parsed
    }
    return parsed.token ?? parsed.id_token ?? parsed.attestation_token ?? responseBody
  } catch {
    return responseBody
  }
}

function run(commandName, commandArgs) {
  const result = spawnSync(commandName, commandArgs, { stdio: 'inherit' })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${commandName} ${commandArgs.join(' ')} exited with status ${result.status}`)
  }
}

function parseArgs(argv) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      parsed._.push(item)
      continue
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

function required(value, message) {
  if (!value) {
    throw new Error(message)
  }
  return value
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
