import { createHash } from 'crypto'
import { deriveKeysetId } from '@cashu/cashu-ts'
import { KeysetRepository } from '../../database/repositories/KeysetRepository.js'
import { Keyset } from '../models/Keyset.js'
import { MintKeys } from '../../types/cashu.js'
import { KeysetNotFoundError, KeysetInactiveError, hasErrorCode } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import { env } from '../../config/env.js'
import { getPublicKey } from '@noble/secp256k1'
import { KeyEncryptor } from './KeyEncryptor.js'

// Standard Cashu denominations (powers of 2)
const DENOMINATIONS = [
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072,
  262144, 524288, 1048576, 2097152, 4194304, 8388608,
]

export const DEFAULT_INPUT_FEE_PPK = 0

function configuredInputFeePpk(): number {
  return env.MINT_INPUT_FEE_PPK
}

export function deriveMintKeysetId(
  publicKeys: Record<number, string>,
  unit: string,
  inputFeePpk = 0,
  finalExpiry?: number
): string {
  return deriveKeysetId(publicKeys, {
    unit,
    input_fee_ppk: inputFeePpk,
    expiry: finalExpiry,
  })
}

export class KeyManager {
  private keysetCache = new Map<string, Keyset>()
  private keyEncryptor: KeyEncryptor

  constructor(private keysetRepo: KeysetRepository) {
    this.keyEncryptor = new KeyEncryptor()
  }

  /**
   * Generate a new keyset for a Rune
   */
  async generateKeyset(runeId: string, unit: string = 'unit'): Promise<Keyset> {
    logger.info({ runeId, unit }, 'Generating new keyset')

    // Generate seed from mint seed + rune ID + unit for deterministic keys
    // IMPORTANT: Must be deterministic so keys survive server restarts
    // IMPORTANT: Unit must be included to ensure different units have different keysets
    const seed = Buffer.concat([
      Buffer.from(env.MINT_SEED, 'hex'),
      Buffer.from(runeId),
      Buffer.from(unit),
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

    const inputFeePpk = configuredInputFeePpk()
    const id = deriveMintKeysetId(public_keys, unit, inputFeePpk)

    // Encrypt private keys before storing
    const encryptedPrivateKeys = await this.encryptKeys(private_keys, id)

    const keyset: Keyset = {
      id,
      unit,
      rune_id: runeId,
      active: true,
      private_keys: encryptedPrivateKeys,
      public_keys,
      input_fee_ppk: inputFeePpk,
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
  async getPrivateKey(keysetId: string, amount: number): Promise<string> {
    let keyset = this.keysetCache.get(keysetId)

    if (!keyset) {
      // Load from database if not in cache
      try {
        const dbKeyset = await this.keysetRepo.findByIdOrThrow(keysetId)

        // Decrypt private keys and cache
        const decryptedPrivateKeys = await this.decryptKeys(dbKeyset.private_keys, dbKeyset.id)
        keyset = {
          ...dbKeyset,
          private_keys: decryptedPrivateKeys,
        }
        this.keysetCache.set(keysetId, keyset)

        logger.debug({ keysetId }, 'Keyset loaded from database into cache')
      } catch (error) {
        throw new KeysetNotFoundError(keysetId)
      }
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
      const decryptedPrivateKeys = await this.decryptKeys(keyset.private_keys, keyset.id)
      this.keysetCache.set(keysetId, {
        ...keyset,
        private_keys: decryptedPrivateKeys,
      })
    }

    return {
      id: keyset.id,
      unit: keyset.unit,
      active: keyset.active,
      input_fee_ppk: keyset.input_fee_ppk ?? 0,
      final_expiry: keyset.final_expiry,
      keys: keyset.public_keys,
    }
  }

  async getInputFeePpk(keysetId: string): Promise<number> {
    const keyset = this.keysetCache.get(keysetId)

    if (keyset) {
      return keyset.input_fee_ppk ?? 0
    }

    const dbKeyset = await this.keysetRepo.findByIdOrThrow(keysetId)
    return dbKeyset.input_fee_ppk ?? 0
  }

  /**
   * Get all active keysets
   */
  async getActiveKeysets(): Promise<Keyset[]> {
    const keysets = await this.keysetRepo.findActive()

    // Decrypt and cache all active keysets
    for (const keyset of keysets) {
      if (!this.keysetCache.has(keyset.id)) {
        const decryptedPrivateKeys = await this.decryptKeys(keyset.private_keys, keyset.id)
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
        const decryptedPrivateKeys = await this.decryptKeys(keyset.private_keys, keyset.id)
        this.keysetCache.set(keyset.id, {
          ...keyset,
          private_keys: decryptedPrivateKeys,
        })
      }
    }

    return keysets
  }

  /**
   * Get active keyset for a specific rune ID and unit
   */
  async getKeysetByRuneIdAndUnit(runeId: string, unit: string): Promise<Keyset | null> {
    let keyset = await this.keysetRepo.findActiveByRuneIdAndUnit(runeId, unit)

    if (!keyset) {
      return null
    }

    const inputFeePpk = configuredInputFeePpk()
    if ((keyset.input_fee_ppk ?? 0) !== inputFeePpk) {
      logger.info(
        {
          keysetId: keyset.id,
          runeId,
          unit,
          inputFeePpk: keyset.input_fee_ppk ?? 0,
          targetInputFeePpk: inputFeePpk,
        },
        'Generating replacement keyset with protocol input fees'
      )
      try {
        keyset = await this.generateKeyset(runeId, unit)
      } catch (error) {
        if (!hasErrorCode(error, '23505')) {
          throw error
        }

        keyset = await this.keysetRepo.findActiveByRuneIdAndUnit(runeId, unit)
        if (!keyset) {
          throw error
        }
      }
    }

    // Decrypt and cache if not already cached
    if (!this.keysetCache.has(keyset.id)) {
      const decryptedPrivateKeys = await this.decryptKeys(keyset.private_keys, keyset.id)
      this.keysetCache.set(keyset.id, {
        ...keyset,
        private_keys: decryptedPrivateKeys,
      })
    }

    return keyset
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
  private async encryptKeys(
    keys: Record<number, string>,
    keysetId: string
  ): Promise<Record<number, string>> {
    const encrypted: Record<number, string> = {}

    for (const [amount, key] of Object.entries(keys)) {
      encrypted[parseInt(amount)] = await this.keyEncryptor.encrypt(
        key,
        this.keyEncryptionContext(keysetId, amount)
      )
    }

    return encrypted
  }

  /**
   * Decrypt private keys from storage
   */
  private async decryptKeys(
    encryptedKeys: Record<number, string>,
    keysetId: string
  ): Promise<Record<number, string>> {
    const decrypted: Record<number, string> = {}

    for (const [amount, encryptedKey] of Object.entries(encryptedKeys)) {
      decrypted[parseInt(amount)] = await this.keyEncryptor.decrypt(
        encryptedKey,
        this.keyEncryptionContext(keysetId, amount)
      )
    }

    return decrypted
  }

  private keyEncryptionContext(keysetId: string, amount: string): string {
    return `ducat-mint:keyset:${keysetId}:amount:${amount}`
  }

  /**
   * Load a keyset into cache (used on startup)
   */
  async loadKeyset(keysetId: string): Promise<void> {
    const keyset = await this.keysetRepo.findByIdOrThrow(keysetId)
    const decryptedPrivateKeys = await this.decryptKeys(keyset.private_keys, keyset.id)
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
