import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import http from 'http'
import { env } from '../../config/env.js'
import { logger } from '../../utils/logger.js'

const LOCAL_PREFIX = 'local-v1'
const GCP_KMS_PREFIX = 'gcp-kms-v1'

export class KeyEncryptor {
  private readonly localKey?: Buffer
  private cachedAccessToken?: { token: string; expiresAtMs: number }

  constructor(
    private readonly mode = env.KEY_ENCRYPTION_MODE,
    private readonly kmsKeyName = env.KMS_KEY_NAME
  ) {
    if (mode === 'local') {
      if (!env.ENCRYPTION_KEY) {
        throw new Error('ENCRYPTION_KEY is required when KEY_ENCRYPTION_MODE=local')
      }
      this.localKey = Buffer.from(env.ENCRYPTION_KEY, 'hex')
    }

    if ((mode === 'gcp-kms' || mode === 'gcp-confidential-space-kms') && !kmsKeyName) {
      throw new Error('KMS_KEY_NAME is required when KEY_ENCRYPTION_MODE uses Cloud KMS')
    }

    if (
      mode === 'gcp-confidential-space-kms' &&
      !env.GCP_WORKLOAD_IDENTITY_AUDIENCE &&
      !process.env.GOOGLE_OAUTH_ACCESS_TOKEN
    ) {
      throw new Error(
        'GCP_WORKLOAD_IDENTITY_AUDIENCE is required when KEY_ENCRYPTION_MODE=gcp-confidential-space-kms'
      )
    }
  }

  async encrypt(plaintext: string, aad: string): Promise<string> {
    if (this.usesCloudKms()) {
      return this.encryptWithCloudKms(plaintext, aad)
    }

    return this.encryptLocal(plaintext, aad)
  }

  async decrypt(ciphertext: string, aad: string): Promise<string> {
    if (ciphertext.startsWith(`${GCP_KMS_PREFIX}:`)) {
      return this.decryptWithCloudKms(ciphertext, aad)
    }

    return this.decryptLocal(ciphertext, aad)
  }

  private encryptLocal(plaintext: string, aad: string): string {
    const key = this.getLocalKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(aad, 'utf8'))

    const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
    const tag = cipher.getAuthTag()

    return [LOCAL_PREFIX, iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(
      ':'
    )
  }

  private decryptLocal(ciphertext: string, aad: string): string {
    if (ciphertext.startsWith(`${LOCAL_PREFIX}:`)) {
      const [, ivHex, tagHex, encryptedHex] = ciphertext.split(':')
      if (!ivHex || !tagHex || !encryptedHex) {
        throw new Error('Invalid local encrypted key payload')
      }

      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.getLocalKey(),
        Buffer.from(ivHex, 'hex')
      )
      decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'))

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, 'hex')),
        decipher.final(),
      ])

      return decrypted.toString('utf8')
    }

    return this.decryptLegacyLocal(ciphertext)
  }

  private decryptLegacyLocal(ciphertext: string): string {
    const [ivHex, encryptedHex] = ciphertext.split(':')
    if (!ivHex || !encryptedHex) {
      throw new Error('Invalid legacy encrypted key payload')
    }

    const decipher = createDecipheriv('aes-256-cbc', this.getLocalKey(), Buffer.from(ivHex, 'hex'))
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  private async encryptWithCloudKms(plaintext: string, aad: string): Promise<string> {
    const response = await this.callCloudKms('encrypt', {
      plaintext: Buffer.from(plaintext, 'utf8').toString('base64'),
      additionalAuthenticatedData: Buffer.from(aad, 'utf8').toString('base64'),
    })

    return `${GCP_KMS_PREFIX}:${response.ciphertext}`
  }

  private async decryptWithCloudKms(ciphertext: string, aad: string): Promise<string> {
    const [, encryptedPayload] = ciphertext.split(':', 2)
    if (!encryptedPayload) {
      throw new Error('Invalid Cloud KMS encrypted key payload')
    }

    const response = await this.callCloudKms('decrypt', {
      ciphertext: encryptedPayload,
      additionalAuthenticatedData: Buffer.from(aad, 'utf8').toString('base64'),
    })

    return Buffer.from(response.plaintext, 'base64').toString('utf8')
  }

  private async callCloudKms(
    operation: 'encrypt' | 'decrypt',
    body: Record<string, string>
  ): Promise<Record<string, string>> {
    const accessToken = await this.getAccessToken()
    const response = await fetch(
      `https://cloudkms.googleapis.com/v1/${this.kmsKeyName}:${operation}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      logger.error(
        { status: response.status, operation, kmsKeyName: this.kmsKeyName, errorText },
        'Cloud KMS request failed'
      )
      throw new Error(`Cloud KMS ${operation} failed with status ${response.status}`)
    }

    return response.json() as Promise<Record<string, string>>
  }

  private async getAccessToken(): Promise<string> {
    if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
      return process.env.GOOGLE_OAUTH_ACCESS_TOKEN
    }

    if (this.mode === 'gcp-confidential-space-kms') {
      return this.getConfidentialSpaceAccessToken()
    }

    const response = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    )

    if (!response.ok) {
      throw new Error(`Failed to fetch metadata access token: ${response.status}`)
    }

    const payload = (await response.json()) as { access_token?: string }
    if (!payload.access_token) {
      throw new Error('Metadata access token response did not include access_token')
    }

    return payload.access_token
  }

  private async getConfidentialSpaceAccessToken(): Promise<string> {
    if (this.cachedAccessToken && this.cachedAccessToken.expiresAtMs > Date.now() + 60_000) {
      return this.cachedAccessToken.token
    }

    const subjectToken = await this.getConfidentialSpaceSubjectToken()
    const audience = env.GCP_WORKLOAD_IDENTITY_AUDIENCE
    if (!audience) {
      throw new Error('GCP_WORKLOAD_IDENTITY_AUDIENCE is required for Confidential Space KMS')
    }

    const response = await fetch('https://sts.googleapis.com/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        audience,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
        subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
        subjectToken,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error(
        { status: response.status, audience, errorText },
        'Confidential Space STS token exchange failed'
      )
      throw new Error(`Confidential Space STS token exchange failed with status ${response.status}`)
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number }
    if (!payload.access_token) {
      throw new Error('Confidential Space STS response did not include access_token')
    }

    this.cachedAccessToken = {
      token: payload.access_token,
      expiresAtMs: Date.now() + (payload.expires_in ?? 3600) * 1000,
    }

    return payload.access_token
  }

  private async getConfidentialSpaceSubjectToken(): Promise<string> {
    const body = JSON.stringify({
      audience: env.GCP_ATTESTATION_TOKEN_AUDIENCE,
      token_type: 'OIDC',
    })

    const token = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: env.CONFIDENTIAL_SPACE_TOKEN_SOCKET,
          path: '/v1/token',
          method: 'POST',
          headers: {
            Host: 'localhost',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString('utf8').trim()
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                new Error(
                  `Confidential Space token endpoint failed with status ${response.statusCode}: ${responseBody}`
                )
              )
              return
            }

            resolve(this.extractConfidentialSpaceToken(responseBody))
          })
        }
      )

      request.on('error', reject)
      request.write(body)
      request.end()
    })

    if (!token.includes('.')) {
      throw new Error('Confidential Space token endpoint returned a non-JWT token')
    }

    return token
  }

  private extractConfidentialSpaceToken(responseBody: string): string {
    try {
      const parsed = JSON.parse(responseBody) as
        | string
        | {
            token?: string
            id_token?: string
            attestation_token?: string
          }
      if (typeof parsed === 'string') {
        return parsed
      }

      return parsed.token ?? parsed.id_token ?? parsed.attestation_token ?? responseBody
    } catch {
      return responseBody
    }
  }

  private usesCloudKms(): boolean {
    return this.mode === 'gcp-kms' || this.mode === 'gcp-confidential-space-kms'
  }

  private getLocalKey(): Buffer {
    if (!this.localKey) {
      throw new Error('Local encryption key is not configured')
    }

    return this.localKey
  }
}
