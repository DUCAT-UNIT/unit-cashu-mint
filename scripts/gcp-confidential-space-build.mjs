#!/usr/bin/env node
import { createSign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = parseArgs(process.argv.slice(2))
const tfvars = await readTfvars(args.tfvars ?? join(repoRoot, 'terraform/gcp/terraform.tfvars'))

const projectId = args.project ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? tfvars.project_id
const location = args.location ?? process.env.GCP_LOCATION ?? tfvars.artifact_registry_location ?? tfvars.region ?? 'us-central1'
const repository = args.repository ?? process.env.ARTIFACT_REGISTRY_REPOSITORY ?? tfvars.artifact_registry_repository_id ?? 'ducat-mint'
const imageName = args.image ?? process.env.ARTIFACT_REGISTRY_IMAGE ?? tfvars.artifact_registry_image_name ?? 'mint-server'
const tag = args.tag ?? process.env.IMAGE_TAG ?? (await git(['rev-parse', '--short', 'HEAD'])).trim()
const bucket = args.bucket ?? process.env.CLOUD_BUILD_SOURCE_BUCKET ?? `${projectId}-ducat-mint-cloudbuild-source`

if (!projectId) {
  throw new Error('GCP project is required. Pass --project or set project_id in terraform/gcp/terraform.tfvars.')
}

const host = `${location}-docker.pkg.dev`
const imageTag = `${host}/${projectId}/${repository}/${imageName}:${tag}`
const sourceObject = `confidential-space-source/${tag}-${Date.now()}.tar.gz`

const token = await getAccessToken()

await enableProjectService(token, projectId, 'artifactregistry.googleapis.com')
await enableProjectService(token, projectId, 'cloudbuild.googleapis.com')
await enableProjectService(token, projectId, 'storage.googleapis.com')

await ensureArtifactRegistryRepository(token, { projectId, location, repository })
await ensureBucket(token, { projectId, bucket, location })

const tempDir = await mkdtemp('/tmp/ducat-mint-cloud-build-')
const archivePath = join(tempDir, 'source.tar.gz')

try {
  await createSourceArchive(archivePath)
  await uploadSourceArchive(token, { bucket, object: sourceObject, archivePath })
  const build = await runBuild(token, {
    projectId,
    bucket,
    object: sourceObject,
    imageTag,
  })
  const digest = findImageDigest(build, imageTag)
  const pinnedReference = `${host}/${projectId}/${repository}/${imageName}@${digest}`

  console.log(`image_tag=${imageTag}`)
  console.log(`confidential_space_image_reference=${pinnedReference}`)
  console.log(`confidential_space_image_digest=${digest}`)
  console.log('')
  console.log('Terraform values:')
  console.log(`confidential_space_image_reference = "${pinnedReference}"`)
  console.log(`confidential_space_image_digest    = "${digest}"`)
} finally {
  await rm(tempDir, { recursive: true, force: true })
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
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/)
      if (match) {
        values[match[1]] = match[2]
      }
    }
    return values
  } catch {
    return {}
  }
}

async function getAccessToken() {
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
      throw new Error(`Service account token exchange failed: ${response.status} ${await response.text()}`)
    }

    const payload = await response.json()
    return payload.access_token
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
  return buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

async function ensureArtifactRegistryRepository(accessToken, { projectId, location, repository }) {
  const name = `projects/${projectId}/locations/${location}/repositories/${repository}`
  const existing = await googleFetch(accessToken, `https://artifactregistry.googleapis.com/v1/${name}`, {
    allowNotFound: true,
  })
  if (existing) {
    return
  }

  const operation = await googleFetch(
    accessToken,
    `https://artifactregistry.googleapis.com/v1/projects/${projectId}/locations/${location}/repositories?repositoryId=${encodeURIComponent(repository)}`,
    {
      method: 'POST',
      body: {
        format: 'DOCKER',
        description: 'Ducat mint Confidential Space workload images',
      },
    }
  )
  if (operation?.name) {
    await waitForGoogleOperation(
      accessToken,
      `https://artifactregistry.googleapis.com/v1/${operation.name}`
    )
  }
}

async function enableProjectService(accessToken, projectId, serviceName) {
  const operation = await googleFetch(
    accessToken,
    `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/${serviceName}:enable`,
    {
      method: 'POST',
      body: {},
    }
  )
  if (operation?.name && !operation.done && !operation.name.includes('DONE_OPERATION')) {
    await waitForGoogleOperation(
      accessToken,
      `https://serviceusage.googleapis.com/v1/${operation.name}`
    )
  }
}

async function ensureBucket(accessToken, { projectId, bucket, location }) {
  const existing = await googleFetch(accessToken, `https://storage.googleapis.com/storage/v1/b/${bucket}`, {
    allowNotFound: true,
  })
  if (existing) {
    return
  }

  await googleFetch(accessToken, `https://storage.googleapis.com/storage/v1/b?project=${projectId}`, {
    method: 'POST',
    body: {
      name: bucket,
      location: location.toUpperCase(),
      iamConfiguration: {
        uniformBucketLevelAccess: {
          enabled: true,
        },
      },
    },
  })
}

async function createSourceArchive(archivePath) {
  await run('tar', [
    '--exclude=.git',
    '--exclude=.DS_Store',
    '--exclude=._*',
    '--exclude=.env',
    '--exclude=.env.*',
    '--exclude=node_modules',
    '--exclude=dist',
    '--exclude=coverage',
    '--exclude=terraform/.terraform',
    '--exclude=terraform/gcp/.terraform',
    '--exclude=terraform/gcp/terraform.tfstate',
    '--exclude=terraform/gcp/terraform.tfstate.backup',
    '--exclude=parent',
    '--exclude=enclave',
    '-czf',
    archivePath,
    '.',
  ])
}

async function uploadSourceArchive(accessToken, { bucket, object, archivePath }) {
  const archive = await readFile(archivePath)
  const response = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(object)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/gzip',
      },
      body: archive,
    }
  )

  if (!response.ok) {
    throw new Error(`GCS source upload failed: ${response.status} ${await response.text()}`)
  }
}

async function runBuild(accessToken, { projectId, bucket, object, imageTag }) {
  const operation = await googleFetch(
    accessToken,
    `https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds`,
    {
      method: 'POST',
      body: {
        source: {
          storageSource: {
            bucket,
            object,
          },
        },
        steps: [
          {
            name: 'gcr.io/cloud-builders/docker',
            args: ['build', '-f', 'gcp-confidential-space/Dockerfile', '-t', imageTag, '.'],
          },
          {
            name: 'gcr.io/cloud-builders/docker',
            args: ['push', imageTag],
          },
        ],
        images: [imageTag],
        timeout: '1200s',
      },
    }
  )

  const completed = await waitForOperation(accessToken, operation.name)
  if (completed.error) {
    throw new Error(`Cloud Build failed: ${JSON.stringify(completed.error)}`)
  }

  const build = completed.response ?? completed.metadata?.build
  if (build?.id) {
    return googleFetch(
      accessToken,
      `https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds/${build.id}`
    )
  }

  return build
}

async function waitForOperation(accessToken, operationName) {
  return waitForGoogleOperation(accessToken, `https://cloudbuild.googleapis.com/v1/${operationName}`)
}

async function waitForGoogleOperation(accessToken, url) {
  let delayMs = 5000
  while (true) {
    const operation = await googleFetch(accessToken, url)
    if (operation.done) {
      return operation
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs))
    delayMs = Math.min(delayMs + 5000, 30000)
  }
}

function findImageDigest(build, imageTag) {
  const image = build?.results?.images?.find((candidate) => candidate.name === imageTag)
  const digest = image?.digest ?? build?.results?.images?.[0]?.digest
  if (!digest) {
    throw new Error(`Cloud Build completed but did not return an image digest: ${JSON.stringify(build?.results)}`)
  }

  return digest
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
    throw new Error(`${options.method ?? 'GET'} ${url} failed: ${response.status} ${await response.text()}`)
  }

  if (response.status === 204) {
    return null
  }

  return response.json()
}

async function git(args) {
  const chunks = []
  await run('git', args, {
    stdout: (chunk) => chunks.push(chunk),
  })
  return Buffer.concat(chunks).toString('utf8')
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      COPYFILE_DISABLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    const stderr = []

    child.stdout.on('data', (chunk) => {
      options.stdout?.(chunk)
    })
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      reject(new Error(`${command} ${args.join(' ')} failed with ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
    })
  })
}
