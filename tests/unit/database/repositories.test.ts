import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { ProofRepository } from '../../../src/database/repositories/ProofRepository.js'
import { QuoteRepository } from '../../../src/database/repositories/QuoteRepository.js'
import { KeysetRepository } from '../../../src/database/repositories/KeysetRepository.js'
import { KeyManager } from '../../../src/core/crypto/KeyManager.js'
import type { Proof } from '../../../src/types/cashu.js'

describe('ProofRepository', () => {
  let proofRepo: ProofRepository
  let keysetId: string

  beforeAll(async () => {
    // Create a test keyset for foreign key constraints
    const keysetRepo = new KeysetRepository()
    const keyManager = new KeyManager(keysetRepo)
    const keyset = await keyManager.generateKeyset('840000:3', 'sat')
    keysetId = keyset.id
  })

  beforeEach(() => {
    proofRepo = new ProofRepository()
  })

  describe('checkSpent', () => {
    it('should return empty array for unspent proofs', async () => {
      const spent = await proofRepo.checkSpent(['nonexistent_y_value'])

      expect(spent).toEqual([])
    })

    it('should return spent Y values', async () => {
      const testProof: Proof = {
        amount: 8,
        id: keysetId,
        secret: 'test_secret_' + Date.now(),
        C: '02' + '0'.repeat(64),
      }

      const Y = 'test_y_' + Date.now()

      await proofRepo.markSpent([testProof], [Y], 'test_tx')

      const spent = await proofRepo.checkSpent([Y])
      expect(spent).toContain(Y)
    })
  })

  describe('markSpent', () => {
    it('should mark proofs as spent', async () => {
      const testProof: Proof = {
        amount: 8,
        id: keysetId,
        secret: 'test_secret_' + Date.now(),
        C: '02' + '0'.repeat(64),
      }

      const Y = 'test_y_' + Date.now()

      await proofRepo.markSpent([testProof], [Y], 'test_tx')

      const found = await proofRepo.findByY(Y)
      expect(found).toBeDefined()
      expect(found?.state).toBe('SPENT')
    })

    it('should throw ProofAlreadySpentError if proof already spent', async () => {
      const testProof: Proof = {
        amount: 8,
        id: keysetId,
        secret: 'test_secret_' + Date.now(),
        C: '02' + '0'.repeat(64),
      }

      const Y = 'test_y_' + Date.now()

      await proofRepo.markSpent([testProof], [Y], 'test_tx_1')

      await expect(
        proofRepo.markSpent([testProof], [Y], 'test_tx_2')
      ).rejects.toThrow('Proof already spent')
    })

    it('should handle proofs with witness', async () => {
      const testProof: Proof = {
        amount: 8,
        id: keysetId,
        secret: 'test_secret_' + Date.now(),
        C: '02' + '0'.repeat(64),
        witness: '{"signatures": ["sig1"]}',
      }

      const Y = 'test_y_witness_' + Date.now()

      await proofRepo.markSpent([testProof], [Y], 'test_tx_witness')

      const found = await proofRepo.findByY(Y)
      expect(found?.witness).toBeDefined()
    })
  })

  describe('findByY', () => {
    it('should return null for nonexistent Y', async () => {
      const found = await proofRepo.findByY('nonexistent')

      expect(found).toBeNull()
    })

    it('should find proof by Y', async () => {
      const testProof: Proof = {
        amount: 8,
        id: keysetId,
        secret: 'test_secret_' + Date.now(),
        C: '02' + '0'.repeat(64),
      }

      // Generate unique Y value using timestamp
      const Y = '02' + Date.now().toString(16).padStart(64, '0').slice(0, 64)

      await proofRepo.markSpent([testProof], [Y], 'test_tx_find')

      const found = await proofRepo.findByY(Y)
      expect(found).toBeDefined()
      expect(found?.state).toBe('SPENT')
    })
  })

  describe('findBySecret', () => {
    it('should return null for nonexistent secret', async () => {
      const found = await proofRepo.findBySecret('nonexistent')

      expect(found).toBeNull()
    })

    it('should find proof by secret', async () => {
      const secret = 'test_secret_find_' + Date.now()
      const testProof: Proof = {
        amount: 8,
        id: keysetId,
        secret,
        C: '02' + '0'.repeat(64),
      }

      const Y = 'test_y_secret_' + Date.now()

      await proofRepo.markSpent([testProof], [Y], 'test_tx')

      const found = await proofRepo.findBySecret(secret)
      expect(found).toBeDefined()
      expect(found?.secret).toBe(secret)
    })
  })

  describe('findByTransactionId', () => {
    it('should find proofs by transaction ID', async () => {
      const txId = 'test_tx_' + Date.now()
      const testProof: Proof = {
        amount: 8,
        id: keysetId,
        secret: 'test_secret_' + Date.now(),
        C: '02' + '0'.repeat(64),
      }

      const Y = 'test_y_tx_' + Date.now()

      await proofRepo.markSpent([testProof], [Y], txId)

      const proofs = await proofRepo.findByTransactionId(txId)
      expect(proofs.length).toBeGreaterThan(0)
      expect(proofs[0].transaction_id).toBe(txId)
    })
  })

  describe('getSpentCount', () => {
    it('should return count of spent proofs', async () => {
      const count = await proofRepo.getSpentCount()

      expect(typeof count).toBe('number')
      expect(count).toBeGreaterThanOrEqual(0)
    })
  })

  describe('getSpentAmount', () => {
    it('should return total amount of spent proofs', async () => {
      const amount = await proofRepo.getSpentAmount()

      expect(typeof amount).toBe('number')
      expect(amount).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('QuoteRepository', () => {
  let quoteRepo: QuoteRepository

  beforeEach(() => {
    quoteRepo = new QuoteRepository()
  })

  describe('createMintQuote', () => {
    it('should create a mint quote', async () => {
      const quoteId = 'mint_quote_' + Date.now()

      await quoteRepo.createMintQuote({
        id: quoteId,
        amount: 1000,
        unit: 'sat',
        rune_id: '840000:3',
        request: 'test_request_' + Date.now(),
        state: 'UNPAID',
        expiry: Date.now() + 3600000,
        issued: false,
      })

      const found = await quoteRepo.findMintQuoteById(quoteId)
      expect(found).toBeDefined()
      expect(found?.id).toBe(quoteId)
      expect(found?.amount).toBe(1000)
    })
  })

  describe('findMintQuoteById', () => {
    it('should return null for nonexistent quote', async () => {
      const found = await quoteRepo.findMintQuoteById('nonexistent')

      expect(found).toBeNull()
    })
  })

  describe('updateMintQuoteState', () => {
    it('should update mint quote state', async () => {
      const quoteId = 'mint_quote_update_' + Date.now()

      await quoteRepo.createMintQuote({
        id: quoteId,
        amount: 1000,
        unit: 'sat',
        rune_id: '840000:3',
        request: 'test_req',
        state: 'UNPAID',
        expiry: Date.now() + 3600000,
        issued: false,
      })

      await quoteRepo.updateMintQuoteState(quoteId, 'PAID')

      const found = await quoteRepo.findMintQuoteById(quoteId)
      expect(found?.state).toBe('PAID')
    })
  })

  describe('findMintQuoteByRequest', () => {
    it('should find mint quote by request address', async () => {
      const quoteId = 'mint_quote_request_' + Date.now()
      const request = 'test_request_' + Date.now()

      await quoteRepo.createMintQuote({
        id: quoteId,
        amount: 1000,
        unit: 'sat',
        rune_id: '840000:3',
        request,
        state: 'UNPAID',
        expiry: Date.now() + 3600000,
        issued: false,
      })

      const found = await quoteRepo.findMintQuoteByRequest(request)
      expect(found).toBeDefined()
      expect(found?.id).toBe(quoteId)
    })
  })

  describe('createMeltQuote', () => {
    it('should create a melt quote', async () => {
      const quoteId = 'melt_quote_' + Date.now()

      await quoteRepo.createMeltQuote({
        id: quoteId,
        amount: 1000,
        fee_reserve: 100,
        unit: 'sat',
        rune_id: '840000:3',
        request: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        state: 'UNPAID',
        expiry: Date.now() + 3600000,
      })

      const found = await quoteRepo.findMeltQuoteById(quoteId)
      expect(found).toBeDefined()
      expect(found?.id).toBe(quoteId)
      expect(found?.amount).toBe(1000)
      expect(found?.fee_reserve).toBe(100)
    })
  })

  describe('findMeltQuoteById', () => {
    it('should return null for nonexistent quote', async () => {
      const found = await quoteRepo.findMeltQuoteById('nonexistent')

      expect(found).toBeNull()
    })
  })

  describe('updateMeltQuoteState', () => {
    it('should update melt quote with payment details', async () => {
      const quoteId = 'melt_quote_paid_' + Date.now()

      await quoteRepo.createMeltQuote({
        id: quoteId,
        amount: 1000,
        fee_reserve: 100,
        unit: 'sat',
        rune_id: '840000:3',
        request: 'test_addr',
        state: 'UNPAID',
        expiry: Date.now() + 3600000,
      })

      await quoteRepo.updateMeltQuoteState(quoteId, 'PAID', 'txid123', 50)

      const found = await quoteRepo.findMeltQuoteById(quoteId)
      expect(found?.state).toBe('PAID')
      expect(found?.txid).toBe('txid123')
      expect(found?.fee_paid).toBe(50)
    })
  })
})

describe('KeysetRepository', () => {
  let keysetRepo: KeysetRepository

  beforeEach(() => {
    keysetRepo = new KeysetRepository()
  })

  describe('findById', () => {
    it('should return null for nonexistent keyset', async () => {
      const found = await keysetRepo.findById('nonexistent')

      expect(found).toBeNull()
    })
  })

  describe('findByIdOrThrow', () => {
    it('should throw for nonexistent keyset', async () => {
      await expect(
        keysetRepo.findByIdOrThrow('nonexistent')
      ).rejects.toThrow('Keyset not found')
    })
  })

  describe('findByRuneId', () => {
    it('should return array of keysets for rune ID', async () => {
      const found = await keysetRepo.findByRuneId('840000:3')

      expect(Array.isArray(found)).toBe(true)
    })
  })

  describe('findActive', () => {
    it('should return array of active keysets', async () => {
      const active = await keysetRepo.findActive()

      expect(Array.isArray(active)).toBe(true)
    })
  })

  describe('findActiveByUnit', () => {
    it('should return array of active keysets for unit', async () => {
      const active = await keysetRepo.findActiveByUnit('sat')

      expect(Array.isArray(active)).toBe(true)
    })
  })

  describe('deactivate', () => {
    it('should deactivate a keyset', async () => {
      // This is tested in KeyManager tests
      // Skipping to avoid creating test keysets here
    })
  })
})
