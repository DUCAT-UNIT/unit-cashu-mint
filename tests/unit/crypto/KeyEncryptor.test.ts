import { createCipheriv, randomBytes } from 'crypto'
import { describe, expect, it } from 'vitest'
import { env } from '../../../src/config/env.js'
import { KeyEncryptor } from '../../../src/core/crypto/KeyEncryptor.js'

describe('KeyEncryptor', () => {
  it('encrypts and decrypts local key payloads with authenticated context', async () => {
    const encryptor = new KeyEncryptor('local')
    const encrypted = await encryptor.encrypt('a'.repeat(64), 'keyset:test:amount:1')

    expect(encrypted).toMatch(/^local-v1:/)
    await expect(encryptor.decrypt(encrypted, 'keyset:test:amount:1')).resolves.toBe('a'.repeat(64))
    await expect(encryptor.decrypt(encrypted, 'keyset:test:amount:2')).rejects.toThrow()
  })

  it('can read legacy AES-CBC local payloads', async () => {
    const encryptor = new KeyEncryptor('local')
    const key = Buffer.from(env.ENCRYPTION_KEY!, 'hex')
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    let encrypted = cipher.update('b'.repeat(64), 'utf8', 'hex')
    encrypted += cipher.final('hex')

    await expect(encryptor.decrypt(`${iv.toString('hex')}:${encrypted}`, 'unused')).resolves.toBe(
      'b'.repeat(64)
    )
  })
})
