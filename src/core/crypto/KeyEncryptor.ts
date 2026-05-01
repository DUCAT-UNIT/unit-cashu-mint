import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { env } from '../../config/env.js'
import { logger } from '../../utils/logger.js'

const LOCAL_PREFIX = 'local-v1'
const GCP_KMS_PREFIX = 'gcp-kms-v1'

export class KeyEncryptor {
  private readonly localKey?: Buffer

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

    if (mode === 'gcp-kms' && !kmsKeyName) {
      throw new Error('KMS_KEY_NAME is required when KEY_ENCRYPTION_MODE=gcp-kms')
    }
  }

  async encrypt(plaintext: string, aad: string): Promise<string> {
    if (this.mode === 'gcp-kms') {
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

  private getLocalKey(): Buffer {
    if (!this.localKey) {
      throw new Error('Local encryption key is not configured')
    }

    return this.localKey
  }
}
