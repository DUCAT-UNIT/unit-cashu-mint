import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto'
import { deriveKeysetId } from '@cashu/cashu-ts'
import { KeysetRepository } from '../../database/repositories/KeysetRepository.js'
import { Keyset } from '../models/Keyset.js'
import { MintKeys } from '../../types/cashu.js'
import { KeysetNotFoundError, KeysetInactiveError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import { env } from '../../config/env.js'
import { getPublicKey } from '@noble/secp256k1'

// Standard Cashu denominations (powers of 2)
const DENOMINATIONS = [
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072,
  262144, 524288, 1048576, 2097152, 4194304, 8388608,
]

export class KeyManager {
  private keysetCache = new Map<string, Keyset>()
  private decryptionKey: Buffer

  constructor(private keysetRepo: KeysetRepository) {
    // Derive AES key from env
    this.decryptionKey = Buffer.from(env.ENCRYPTION_KEY, 'hex')
  }

  /**
   * Generate a new keyset for a Rune
   */
  async generateKeyset(runeId: string, unit: string = 'sat'): Promise<Keyset> {
    logger.info({ runeId, unit }, 'Generating new keyset')

    // Generate seed from mint seed + rune ID for deterministic keys
    const seed = Buffer.concat([
      Buffer.from(env.MINT_SEED, 'hex'),
      Buffer.from(runeId),
      randomBytes(16), // Add randomness for key rotation
    ])

    const private_keys: Record<number, string> = {}
    const public_keys: Record<number, string> = {}

    // Generate key pair for each denomination
    for (const amount of DENOMINATIONS) {
      // Derive private key from seed + amount
      const derivationPath = Buffer.concat([seed, Buffer.from(amount.toString())])
      const hash = createHash('sha256').update(derivationPath).digest()
      const privateKey = hash.toString('hex')

      // Derive public key
      const publicKey = getPublicKey(hash, true)

      private_keys[amount] = privateKey
      public_keys[amount] = Buffer.from(publicKey).toString('hex')
    }

    // Derive keyset ID using cashu-ts (take first 14 chars)
    const fullId = deriveKeysetId(public_keys)
    const id = fullId.substring(0, 14)

    // Encrypt private keys before storing
    const encryptedPrivateKeys = this.encryptKeys(private_keys)

    const keyset: Keyset = {
      id,
      unit,
      rune_id: runeId,
      active: true,
      private_keys: encryptedPrivateKeys,
      public_keys,
      input_fee_ppk: 0,
      created_at: Date.now(),
    }

    // Save to database
    const savedKeyset = await this.keysetRepo.create(keyset)

    // Cache it
    this.keysetCache.set(id, {
      ...savedKeyset,
      private_keys, // Cache decrypted version
    })

    logger.info({ keysetId: id, runeId, unit }, 'Keyset generated and saved')

    return savedKeyset
  }

  /**
   * Get private key for a specific amount in a keyset
   */
  getPrivateKey(keysetId: string, amount: number): string {
    const keyset = this.keysetCache.get(keysetId)
    if (!keyset) {
      throw new KeysetNotFoundError(keysetId)
    }

    if (!keyset.active) {
      throw new KeysetInactiveError(keysetId)
    }

    const privateKey = keyset.private_keys[amount]
    if (!privateKey) {
      throw new Error(`No private key for amount ${amount} in keyset ${keysetId}`)
    }

    return privateKey
  }

  /**
   * Get public keys for a keyset (for /v1/keys endpoint)
   */
  async getPublicKeys(keysetId: string): Promise<MintKeys> {
    let keyset = this.keysetCache.get(keysetId)

    if (!keyset) {
      // Load from database
      keyset = await this.keysetRepo.findByIdOrThrow(keysetId)

      // Decrypt private keys and cache
      const decryptedPrivateKeys = this.decryptKeys(keyset.private_keys)
      this.keysetCache.set(keysetId, {
        ...keyset,
        private_keys: decryptedPrivateKeys,
      })
    }

    return {
      id: keyset.id,
      unit: keyset.unit,
      keys: keyset.public_keys,
    }
  }

  /**
   * Get all active keysets
   */
  async getActiveKeysets(): Promise<Keyset[]> {
    const keysets = await this.keysetRepo.findActive()

    // Decrypt and cache all active keysets
    for (const keyset of keysets) {
      if (!this.keysetCache.has(keyset.id)) {
        const decryptedPrivateKeys = this.decryptKeys(keyset.private_keys)
        this.keysetCache.set(keyset.id, {
          ...keyset,
          private_keys: decryptedPrivateKeys,
        })
      }
    }

    return keysets
  }

  /**
   * Get all active keysets for a specific unit
   */
  async getActiveKeysetsByUnit(unit: string): Promise<Keyset[]> {
    const keysets = await this.keysetRepo.findActiveByUnit(unit)

    // Decrypt and cache
    for (const keyset of keysets) {
      if (!this.keysetCache.has(keyset.id)) {
        const decryptedPrivateKeys = this.decryptKeys(keyset.private_keys)
        this.keysetCache.set(keyset.id, {
          ...keyset,
          private_keys: decryptedPrivateKeys,
        })
      }
    }

    return keysets
  }

  /**
   * Deactivate a keyset (for key rotation)
   */
  async deactivateKeyset(keysetId: string): Promise<void> {
    await this.keysetRepo.setActive(keysetId, false)
    this.keysetCache.delete(keysetId)
    logger.info({ keysetId }, 'Keyset deactivated')
  }

  /**
   * Encrypt private keys for storage
   */
  private encryptKeys(keys: Record<number, string>): Record<number, string> {
    const encrypted: Record<number, string> = {}
    const iv = randomBytes(16)

    for (const [amount, key] of Object.entries(keys)) {
      const cipher = createCipheriv('aes-256-cbc', this.decryptionKey, iv)
      let encryptedKey = cipher.update(key, 'utf8', 'hex')
      encryptedKey += cipher.final('hex')
      encrypted[parseInt(amount)] = `${iv.toString('hex')}:${encryptedKey}`
    }

    return encrypted
  }

  /**
   * Decrypt private keys from storage
   */
  private decryptKeys(encryptedKeys: Record<number, string>): Record<number, string> {
    const decrypted: Record<number, string> = {}

    for (const [amount, encryptedKey] of Object.entries(encryptedKeys)) {
      const [ivHex, keyHex] = encryptedKey.split(':')
      const iv = Buffer.from(ivHex, 'hex')
      const decipher = createDecipheriv('aes-256-cbc', this.decryptionKey, iv)
      let decryptedKey = decipher.update(keyHex, 'hex', 'utf8')
      decryptedKey += decipher.final('utf8')
      decrypted[parseInt(amount)] = decryptedKey
    }

    return decrypted
  }

  /**
   * Load a keyset into cache (used on startup)
   */
  async loadKeyset(keysetId: string): Promise<void> {
    const keyset = await this.keysetRepo.findByIdOrThrow(keysetId)
    const decryptedPrivateKeys = this.decryptKeys(keyset.private_keys)
    this.keysetCache.set(keysetId, {
      ...keyset,
      private_keys: decryptedPrivateKeys,
    })
    logger.debug({ keysetId }, 'Keyset loaded into cache')
  }

  /**
   * Preload all active keysets on startup
   */
  async preloadActiveKeysets(): Promise<void> {
    logger.info('Preloading active keysets...')
    const keysets = await this.getActiveKeysets()
    logger.info({ count: keysets.length }, 'Active keysets preloaded')
  }
}
