import { describe, it, expect, beforeEach } from 'vitest'
import { KeyManager } from '../../../src/core/crypto/KeyManager.js'
import { KeysetRepository } from '../../../src/database/repositories/KeysetRepository.js'
import { query } from '../../../src/database/db.js'

describe('KeyManager', () => {
  let keyManager: KeyManager
  let keysetRepo: KeysetRepository

  beforeEach(() => {
    keysetRepo = new KeysetRepository()
    keyManager = new KeyManager(keysetRepo)
  })

  describe('generateKeyset', () => {
    it('should generate a new keyset with valid keys', async () => {
      const runeId = '840000:3'
      const unit = 'sat'

      const keyset = await keyManager.generateKeyset(runeId, unit)

      expect(keyset).toBeDefined()
      expect(keyset.id).toMatch(/^[0-9a-f]{14}$/) // 14 char hex
      expect(keyset.unit).toBe(unit)
      expect(keyset.rune_id).toBe(runeId)
      expect(keyset.active).toBe(true)

      // Check that we have keys for standard denominations
      expect(keyset.public_keys[1]).toBeDefined()
      expect(keyset.public_keys[2]).toBeDefined()
      expect(keyset.public_keys[1024]).toBeDefined()

      // Public keys should be valid hex
      expect(keyset.public_keys[1]).toMatch(/^[0-9a-f]{66}$/) // Compressed pubkey
    })

    it('should save keyset to database', async () => {
      const keyset = await keyManager.generateKeyset('840000:3', 'sat')

      // Verify it's in the database
      const found = await keysetRepo.findById(keyset.id)
      expect(found).toBeDefined()
      expect(found?.id).toBe(keyset.id)
    })

    it('should encrypt private keys in database', async () => {
      const keyset = await keyManager.generateKeyset('840000:3', 'sat')

      // Fetch from database
      const result = await query<{ private_keys: Record<number, string> | string }>(
        'SELECT private_keys FROM keysets WHERE id = $1',
        [keyset.id]
      )

      const dbPrivateKeys = typeof result.rows[0].private_keys === 'string'
        ? JSON.parse(result.rows[0].private_keys)
        : result.rows[0].private_keys

      // Private keys in DB should be encrypted (contain IV:encrypted format)
      expect(dbPrivateKeys[1]).toContain(':')
      expect(dbPrivateKeys[1].split(':').length).toBe(2)
    })
  })

  describe('getPrivateKey', () => {
    it('should return private key for valid amount', async () => {
      const keyset = await keyManager.generateKeyset('840000:3', 'sat')

      const privateKey = keyManager.getPrivateKey(keyset.id, 8)

      expect(privateKey).toBeDefined()
      expect(privateKey).toMatch(/^[0-9a-f]{64}$/) // 32 bytes hex
    })

    it('should throw for invalid keyset', () => {
      expect(() => {
        keyManager.getPrivateKey('invalid_id', 8)
      }).toThrow()
    })

    it('should throw for invalid amount', async () => {
      const keyset = await keyManager.generateKeyset('840000:3', 'sat')

      expect(() => {
        keyManager.getPrivateKey(keyset.id, 999) // Invalid denomination
      }).toThrow()
    })

    it('should throw KeysetInactiveError for inactive keyset', async () => {
      const keyset = await keyManager.generateKeyset('840000:3', 'sat')
      await keyManager.deactivateKeyset(keyset.id)

      // Reload the keyset to get the updated inactive state
      await keyManager.loadKeyset(keyset.id)

      expect(() => {
        keyManager.getPrivateKey(keyset.id, 8)
      }).toThrow('Keyset inactive')
    })
  })

  describe('getPublicKeys', () => {
    it('should return public keys in correct format', async () => {
      const keyset = await keyManager.generateKeyset('840000:3', 'sat')

      const mintKeys = await keyManager.getPublicKeys(keyset.id)

      expect(mintKeys.id).toBe(keyset.id)
      expect(mintKeys.unit).toBe('sat')
      expect(mintKeys.keys).toBeDefined()
      expect(mintKeys.keys[1]).toBeDefined()
      expect(mintKeys.keys[1]).toMatch(/^[0-9a-f]{66}$/)
    })

    it('should load keyset from database if not cached', async () => {
      const keyset = await keyManager.generateKeyset('840000:3', 'sat')

      // Create new KeyManager instance (empty cache)
      const newKeyManager = new KeyManager(keysetRepo)

      const mintKeys = await newKeyManager.getPublicKeys(keyset.id)

      expect(mintKeys.id).toBe(keyset.id)
      expect(mintKeys.keys[1]).toBe(keyset.public_keys[1])
    })
  })

  describe('getActiveKeysets', () => {
    it('should return all active keysets', async () => {
      await keyManager.generateKeyset('840000:3', 'sat')
      await keyManager.generateKeyset('840000:4', 'sat')

      const activeKeysets = await keyManager.getActiveKeysets()

      expect(activeKeysets.length).toBeGreaterThanOrEqual(2)
      expect(activeKeysets.every((k) => k.active)).toBe(true)
    })

    it('should filter by unit', async () => {
      await keyManager.generateKeyset('840000:3', 'sat')

      const satKeysets = await keyManager.getActiveKeysetsByUnit('sat')

      expect(satKeysets.length).toBeGreaterThanOrEqual(1)
      expect(satKeysets.every((k) => k.unit === 'sat')).toBe(true)
    })
  })

  describe('deactivateKeyset', () => {
    it('should deactivate a keyset', async () => {
      const keyset = await keyManager.generateKeyset('840000:3', 'sat')

      await keyManager.deactivateKeyset(keyset.id)

      const found = await keysetRepo.findById(keyset.id)
      expect(found?.active).toBe(false)
    })
  })

  describe('loadKeyset', () => {
    it('should load keyset into cache', async () => {
      const keyset = await keyManager.generateKeyset('840000:3', 'sat')

      // Create new instance with empty cache
      const newKeyManager = new KeyManager(keysetRepo)

      await newKeyManager.loadKeyset(keyset.id)

      // Should be able to get private key from cache
      const privateKey = newKeyManager.getPrivateKey(keyset.id, 8)
      expect(privateKey).toBeDefined()
    })
  })

  describe('preloadActiveKeysets', () => {
    it('should preload all active keysets', async () => {
      await keyManager.generateKeyset('840000:3', 'sat')
      await keyManager.generateKeyset('840000:4', 'sat')

      // Create new instance
      const newKeyManager = new KeyManager(keysetRepo)

      await newKeyManager.preloadActiveKeysets()

      // Should have loaded keysets into cache
      const activeKeysets = await newKeyManager.getActiveKeysets()
      expect(activeKeysets.length).toBeGreaterThanOrEqual(2)
    })
  })
})
