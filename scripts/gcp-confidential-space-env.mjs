import http from 'node:http'

const tokenSocket = process.env.CONFIDENTIAL_SPACE_TOKEN_SOCKET ?? '/run/container_launcher/teeserver.sock'
const attestationAudience = process.env.GCP_ATTESTATION_TOKEN_AUDIENCE ?? 'https://sts.googleapis.com'
const workloadIdentityAudience = process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE
const secretResource = process.env.MINT_ENV_SECRET_RESOURCE

if (!workloadIdentityAudience) {
  throw new Error('GCP_WORKLOAD_IDENTITY_AUDIENCE is required')
}

if (!secretResource) {
  throw new Error('MINT_ENV_SECRET_RESOURCE is required')
}

const subjectToken = await getConfidentialSpaceToken()
const accessToken = await exchangeSubjectToken(subjectToken)
const secretPayload = await fetchSecret(accessToken, secretResource)

for (const line of secretPayload.split(/\r?\n/)) {
  const stripped = line.trim()
  if (!stripped || stripped.startsWith('#') || !line.includes('=')) {
    continue
  }

  const [key, ...valueParts] = line.split('=')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment key in secret payload: ${key}`)
  }

  console.log(`${key}=${shellQuote(valueParts.join('='))}`)
}

async function getConfidentialSpaceToken() {
  const body = JSON.stringify({
    audience: attestationAudience,
    token_type: 'OIDC',
  })

  const responseBody = await unixSocketPost(tokenSocket, '/v1/token', body)
  const token = extractToken(responseBody)
  if (!token.includes('.')) {
    throw new Error('Confidential Space token endpoint returned a non-JWT token')
  }

  return token
}

async function exchangeSubjectToken(subjectToken) {
  const response = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: workloadIdentityAudience,
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

async function fetchSecret(accessToken, resource) {
  const normalizedResource = normalizeSecretResource(resource)
  const response = await fetch(
    `https://secretmanager.googleapis.com/v1/${normalizedResource}/versions/latest:access`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  )

  if (!response.ok) {
    throw new Error(`Secret Manager access failed: ${response.status} ${await response.text()}`)
  }

  const payload = await response.json()
  const encoded = payload?.payload?.data
  if (!encoded) {
    throw new Error('Secret Manager response did not include payload.data')
  }

  return Buffer.from(encoded, 'base64').toString('utf8')
}

function normalizeSecretResource(resource) {
  if (resource.startsWith('projects/')) {
    return resource.replace(/\/versions\/.*$/, '')
  }

  const projectId = process.env.GCP_PROJECT_ID
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID is required when MINT_ENV_SECRET_RESOURCE is not fully qualified')
  }

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

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
