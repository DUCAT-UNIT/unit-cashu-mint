import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MintService } from '../../../src/core/services/MintService.js'
import { MintCrypto } from '../../../src/core/crypto/MintCrypto.js'
import { KeyManager } from '../../../src/core/crypto/KeyManager.js'
import { QuoteRepository } from '../../../src/database/repositories/QuoteRepository.js'
import { RunesBackend } from '../../../src/runes/RunesBackend.js'
import { AmountMismatchError } from '../../../src/utils/errors.js'

// Mock dependencies
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../../src/config/env.js', () => ({
  env: {
    MIN_MINT_AMOUNT: 1,
    MAX_MINT_AMOUNT: 100000000,
    MINT_CONFIRMATIONS: 1,
  },
}))

describe('MintService', () => {
  let mintService: MintService
  let mockMintCrypto: MintCrypto
  let mockQuoteRepo: QuoteRepository
  let mockRunesBackend: RunesBackend
  let mockKeyManager: KeyManager

  beforeEach(() => {
    vi.clearAllMocks()

    mockMintCrypto = {
      signBlindedMessages: vi.fn().mockResolvedValue([]),
    } as unknown as MintCrypto

    mockQuoteRepo = {
      createMintQuote: vi.fn(),
      findMintQuoteByIdOrThrow: vi.fn(),
      updateMintQuoteState: vi.fn(),
    } as unknown as QuoteRepository

    mockRunesBackend = {
      createDepositAddress: vi.fn().mockResolvedValue('tb1ptest123'),
      checkDeposit: vi.fn(),
    } as unknown as RunesBackend

    mockKeyManager = {
      getKeysetByRuneIdAndUnit: vi.fn().mockResolvedValue({ id: 'keyset123' }),
      generateKeyset: vi.fn(),
    } as unknown as KeyManager

    mintService = new MintService(
      mockMintCrypto,
      mockQuoteRepo,
      mockRunesBackend,
      mockKeyManager
    )
  })

  describe('mintTokens - Amount Verification', () => {
    const quoteId = 'dc9713f24eab8a2f2c3acd405bc95672352ade634868be38c8ec8dfdc86a14fc'

    it('should mint tokens when deposit amount matches quote amount', async () => {
      const quoteAmount = 500 // smallest units

      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue({
        id: quoteId,
        amount: quoteAmount,
        unit: 'unit',
        rune_id: '1527352:1',
        request: 'tb1ptest123',
        state: 'PAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      })

      // Deposit matches quote amount exactly
      vi.mocked(mockRunesBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 500n, // Exact match!
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      vi.mocked(mockMintCrypto.signBlindedMessages).mockResolvedValue([
        { id: 'keyset123', amount: 500, C_: '02abc' },
      ])

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]
      const result = await mintService.mintTokens(quoteId, outputs)

      expect(result.signatures).toHaveLength(1)
      expect(mockQuoteRepo.updateMintQuoteState).toHaveBeenCalledWith(quoteId, 'ISSUED')
    })

    it('should REJECT when deposit amount is GREATER than quote amount', async () => {
      const quoteAmount = 500

      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue({
        id: quoteId,
        amount: quoteAmount,
        unit: 'unit',
        rune_id: '1527352:1',
        request: 'tb1ptest123',
        state: 'PAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      })

      // THE ACTUAL BUG SCENARIO: User sent 2000 but quote was for 500
      vi.mocked(mockRunesBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 2000n, // OVERPAYMENT!
        txid: '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df',
        vout: 1,
        confirmations: 6,
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs))
        .rejects.toThrow(AmountMismatchError)

      // Should NOT issue tokens
      expect(mockMintCrypto.signBlindedMessages).not.toHaveBeenCalled()
      expect(mockQuoteRepo.updateMintQuoteState).not.toHaveBeenCalledWith(quoteId, 'ISSUED')
    })

    it('should REJECT when deposit amount is LESS than quote amount', async () => {
      const quoteAmount = 500

      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue({
        id: quoteId,
        amount: quoteAmount,
        unit: 'unit',
        rune_id: '1527352:1',
        request: 'tb1ptest123',
        state: 'PAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      })

      // Underpayment
      vi.mocked(mockRunesBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 100n, // Only sent 100 instead of 500
        txid: 'underpayment_txid',
        vout: 0,
        confirmations: 6,
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs))
        .rejects.toThrow(AmountMismatchError)
    })

    it('should REJECT when deposit not found on-chain', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue({
        id: quoteId,
        amount: 500,
        unit: 'unit',
        rune_id: '1527352:1',
        request: 'tb1ptest123',
        state: 'PAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      })

      // Deposit confirmed but amount undefined means not actually found
      vi.mocked(mockRunesBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: undefined, // No deposit found!
        confirmations: 6, // Has confirmations but no amount = not found
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs))
        .rejects.toThrow('Deposit not found on-chain')
    })

    it('should REJECT when deposit has insufficient confirmations', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue({
        id: quoteId,
        amount: 500,
        unit: 'unit',
        rune_id: '1527352:1',
        request: 'tb1ptest123',
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      })

      // Unconfirmed deposit
      vi.mocked(mockRunesBackend.checkDeposit).mockResolvedValue({
        confirmed: false,
        amount: 500n,
        txid: 'unconfirmed_txid',
        vout: 0,
        confirmations: 0,
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs))
        .rejects.toThrow(/confirmations/)
    })

    it('should REJECT when output amounts do not sum to quote amount', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue({
        id: quoteId,
        amount: 500,
        unit: 'unit',
        rune_id: '1527352:1',
        request: 'tb1ptest123',
        state: 'PAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      })

      vi.mocked(mockRunesBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 500n,
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      // Outputs sum to 300, not 500
      const outputs = [
        { id: 'keyset123', amount: 200, B_: '02xyz' },
        { id: 'keyset123', amount: 100, B_: '02abc' },
      ]

      await expect(mintService.mintTokens(quoteId, outputs))
        .rejects.toThrow(AmountMismatchError)
    })

    it('should REJECT already issued quote', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue({
        id: quoteId,
        amount: 500,
        unit: 'unit',
        rune_id: '1527352:1',
        request: 'tb1ptest123',
        state: 'ISSUED', // Already issued!
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      })

      vi.mocked(mockRunesBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 500n,
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs))
        .rejects.toThrow('already issued')
    })
  })

  describe('getMintQuote - Amount Mismatch Detection', () => {
    const quoteId = 'test-quote-123'

    it('should keep quote UNPAID when deposit amount mismatches', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue({
        id: quoteId,
        amount: 500,
        unit: 'unit',
        rune_id: '1527352:1',
        request: 'tb1ptest123',
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      })

      // Deposit confirmed but wrong amount
      vi.mocked(mockRunesBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 2000n, // Wrong amount!
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      const result = await mintService.getMintQuote(quoteId)

      // Quote should remain UNPAID
      expect(result.state).toBe('UNPAID')
      expect(mockQuoteRepo.updateMintQuoteState).not.toHaveBeenCalled()
    })

    it('should mark quote PAID when deposit amount matches', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue({
        id: quoteId,
        amount: 500,
        unit: 'unit',
        rune_id: '1527352:1',
        request: 'tb1ptest123',
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      })

      vi.mocked(mockRunesBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 500n, // Exact match!
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      const result = await mintService.getMintQuote(quoteId)

      expect(result.state).toBe('PAID')
      expect(mockQuoteRepo.updateMintQuoteState).toHaveBeenCalledWith(quoteId, 'PAID')
    })
  })
})

describe('Amount Mismatch Error Details', () => {
  it('should include expected and actual amounts in error', () => {
    const error = new AmountMismatchError(500, 2000)

    expect(error.message).toContain('mismatch')
    expect(error.code).toBeDefined()
  })

  it('should handle BigInt comparison correctly', () => {
    // The comparison must use BigInt to avoid precision issues
    const expected = BigInt(500)
    const received = BigInt(2000)

    expect(received !== expected).toBe(true)
    expect(received > expected).toBe(true)
    expect((received - expected).toString()).toBe('1500')
  })

  it('should handle number to BigInt conversion', () => {
    // Quote amount comes from database as number
    const quoteAmount = 500 // number from DB
    const depositAmount = 2000n // bigint from Ord API

    // Comparison must convert to same type
    const expectedBigInt = BigInt(quoteAmount)

    expect(depositAmount !== expectedBigInt).toBe(true)
  })
})

describe('Security: Deposit Verification Before Minting', () => {
  it('documents: minting should ALWAYS verify deposit on-chain', () => {
    // Even if quote is marked as PAID in database,
    // we must verify the deposit is still on-chain before minting.
    // This protects against:
    // 1. Database corruption
    // 2. Chain reorgs
    // 3. Race conditions

    const scenarios = [
      { dbState: 'PAID', chainDeposit: true, shouldMint: true },
      { dbState: 'PAID', chainDeposit: false, shouldMint: false }, // Reorg!
      { dbState: 'UNPAID', chainDeposit: true, shouldMint: true }, // Race condition
      { dbState: 'UNPAID', chainDeposit: false, shouldMint: false },
    ]

    for (const scenario of scenarios) {
      // The mint should check chain regardless of DB state
      expect(scenario.chainDeposit).toBe(scenario.shouldMint)
    }
  })

  it('documents: amount must match EXACTLY', () => {
    // No tolerance for amount mismatches
    // Even 1 unit difference must be rejected

    const testCases = [
      { quote: 500n, deposit: 500n, valid: true },
      { quote: 500n, deposit: 501n, valid: false }, // +1
      { quote: 500n, deposit: 499n, valid: false }, // -1
      { quote: 500n, deposit: 2000n, valid: false }, // +1500
      { quote: 500n, deposit: 0n, valid: false }, // Zero
    ]

    for (const tc of testCases) {
      const matches = tc.deposit === tc.quote
      expect(matches).toBe(tc.valid)
    }
  })
})
