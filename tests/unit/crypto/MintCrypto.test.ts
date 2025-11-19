import { describe, it, expect, beforeEach } from 'vitest'
import { MintCrypto } from '../../../src/core/crypto/MintCrypto.js'
import { KeyManager } from '../../../src/core/crypto/KeyManager.js'
import { KeysetRepository } from '../../../src/database/repositories/KeysetRepository.js'
import { BlindedMessage, Proof } from '../../../src/types/cashu.js'
import { randomBytes } from 'crypto'

// Helper to create a valid blinded message for testing
function createMockBlindedMessage(
  keysetId: string,
  amount: number,
  mintCrypto: MintCrypto
): BlindedMessage {
  // Generate a random secret
  const secret = randomBytes(32).toString('hex')

  // Hash to curve to get Y (this is what the client would do)
  const Y = mintCrypto.hashSecret(secret)

  // Use Y as B_ for testing (in real usage, client would add blinding: B_ = Y + r*G)
  return {
    id: keysetId,
    amount,
    B_: Y,
  }
}

describe('MintCrypto', () => {
  let mintCrypto: MintCrypto
  let keyManager: KeyManager
  let keysetId: string

  beforeEach(async () => {
    const keysetRepo = new KeysetRepository()
    keyManager = new KeyManager(keysetRepo)
    mintCrypto = new MintCrypto(keyManager)

    // Generate a test keyset
    const keyset = await keyManager.generateKeyset('840000:3', 'sat')
    keysetId = keyset.id
  })

  describe('signBlindedMessage', () => {
    it('should sign a blinded message', () => {
      const secret = randomBytes(32).toString('hex')
      const B_ = mintCrypto.hashSecret(secret)

      const message: BlindedMessage = {
        id: keysetId,
        amount: 8,
        B_,
      }

      const signature = mintCrypto.signBlindedMessage(message)

      expect(signature).toBeDefined()
      expect(signature.id).toBe(keysetId)
      expect(signature.amount).toBe(8)
      expect(signature.C_).toMatch(/^[0-9a-f]{66}$/) // Compressed point
    })

    it('should sign multiple messages', () => {
      const messages: BlindedMessage[] = [
        { id: keysetId, amount: 1, B_: mintCrypto.hashSecret(randomBytes(32).toString('hex')) },
        { id: keysetId, amount: 2, B_: mintCrypto.hashSecret(randomBytes(32).toString('hex')) },
        { id: keysetId, amount: 4, B_: mintCrypto.hashSecret(randomBytes(32).toString('hex')) },
      ]

      const signatures = mintCrypto.signBlindedMessages(messages)

      expect(signatures.length).toBe(3)
      expect(signatures[0].amount).toBe(1)
      expect(signatures[1].amount).toBe(2)
      expect(signatures[2].amount).toBe(4)
    })
  })

  describe('hashSecret', () => {
    it('should hash secret to curve point', () => {
      const secret = 'test_secret_' + randomBytes(16).toString('hex')

      const Y = mintCrypto.hashSecret(secret)

      expect(Y).toMatch(/^[0-9a-f]{66}$/) // Compressed point
    })

    it('should be deterministic', () => {
      const secret = 'test_secret_deterministic'

      const Y1 = mintCrypto.hashSecret(secret)
      const Y2 = mintCrypto.hashSecret(secret)

      expect(Y1).toBe(Y2)
    })

    it('should hash multiple secrets', () => {
      const secrets = [
        'secret_1',
        'secret_2',
        'secret_3',
      ]

      const hashes = mintCrypto.hashSecrets(secrets)

      expect(hashes.length).toBe(3)
      expect(hashes[0]).not.toBe(hashes[1])
      expect(hashes[1]).not.toBe(hashes[2])
    })
  })

  describe('sumProofs', () => {
    it('should calculate total amount', () => {
      const proofs: Proof[] = [
        { id: keysetId, amount: 1, secret: 's1', C: '02' + '0'.repeat(64) },
        { id: keysetId, amount: 2, secret: 's2', C: '02' + '0'.repeat(64) },
        { id: keysetId, amount: 4, secret: 's3', C: '02' + '0'.repeat(64) },
      ]

      const total = mintCrypto.sumProofs(proofs)

      expect(total).toBe(7)
    })
  })

  describe('verifyAmount', () => {
    it('should verify correct amount', () => {
      const proofs: Proof[] = [
        { id: keysetId, amount: 1, secret: 's1', C: '02' + '0'.repeat(64) },
        { id: keysetId, amount: 2, secret: 's2', C: '02' + '0'.repeat(64) },
        { id: keysetId, amount: 4, secret: 's3', C: '02' + '0'.repeat(64) },
      ]

      expect(mintCrypto.verifyAmount(proofs, 7)).toBe(true)
      expect(mintCrypto.verifyAmount(proofs, 8)).toBe(false)
    })
  })

  // Note: Full proof verification test would require proper blinding/unblinding
  // which is done by the client. We test the crypto primitives work correctly.
})
