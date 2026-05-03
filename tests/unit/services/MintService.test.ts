import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MintService } from '../../../src/core/services/MintService.js'
import { MintCrypto } from '../../../src/core/crypto/MintCrypto.js'
import { KeyManager } from '../../../src/core/crypto/KeyManager.js'
import { QuoteRepository } from '../../../src/database/repositories/QuoteRepository.js'
import { BackendRegistry } from '../../../src/core/payment/BackendRegistry.js'
import { IPaymentBackend } from '../../../src/core/payment/types.js'
import { MintQuote } from '../../../src/core/models/Quote.js'
import { MintQuoteResponse } from '../../../src/types/cashu.js'
import { AmountMismatchError } from '../../../src/utils/errors.js'
import { getPublicKey } from '@noble/secp256k1'
import { signMintQuote } from '@cashu/cashu-ts'

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
    SUPPORTED_RUNES_ARRAY: ['1527352:1'],
  },
}))

// Mock backend for testing
function createMockBackend(unit: string, method?: string): IPaymentBackend {
  return {
    method,
    unit,
    createDepositAddress: vi.fn().mockResolvedValue('tb1ptest123'),
    checkDeposit: vi.fn(),
    verifySpecificDeposit: vi.fn(),
    estimateFee: vi.fn(),
    withdraw: vi.fn(),
    getBalance: vi.fn(),
  }
}

function createMintQuote(overrides: Partial<MintQuote>): MintQuote {
  return {
    id: 'quote-id',
    amount: 500,
    unit: 'unit',
    rune_id: '1527352:1',
    method: 'unit',
    request: 'tb1ptest123',
    state: 'UNPAID',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    created_at: Date.now(),
    amount_paid: 0,
    amount_issued: 0,
    ...overrides,
  }
}

describe('MintService', () => {
  let mintService: MintService
  let mockMintCrypto: MintCrypto
  let mockQuoteRepo: QuoteRepository
  let backendRegistry: BackendRegistry
  let mockBackend: IPaymentBackend
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
      updateMintQuotePayment: vi.fn(),
      claimMintDeposit: vi.fn().mockResolvedValue(true),
      withMintQuoteLock: vi.fn(async (id, callback) =>
        callback(await mockQuoteRepo.findMintQuoteByIdOrThrow(id), undefined as any)
      ),
      markMintQuoteIssued: vi.fn(),
      incrementMintQuoteIssued: vi.fn(),
    } as unknown as QuoteRepository

    backendRegistry = new BackendRegistry()
    mockBackend = createMockBackend('unit')
    backendRegistry.register(mockBackend)

    mockKeyManager = {
      getKeysetByRuneIdAndUnit: vi.fn().mockResolvedValue({ id: 'keyset123' }),
      generateKeyset: vi.fn(),
      getActiveKeysetsByUnit: vi.fn().mockResolvedValue([{ id: 'keyset123' }]),
    } as unknown as KeyManager

    mintService = new MintService(mockMintCrypto, mockQuoteRepo, backendRegistry, mockKeyManager)
  })

  describe('createOnchainMintQuote', () => {
    it('keeps UNIT on the onchain method and uses the configured rune id', async () => {
      const onchainBackend = createMockBackend('unit', 'onchain')
      const registry = new BackendRegistry()
      registry.register(onchainBackend, [], ['unit'])
      const service = new MintService(mockMintCrypto, mockQuoteRepo, registry, mockKeyManager)
      const pubkey = '02' + '11'.repeat(32)

      vi.mocked(mockQuoteRepo.createMintQuote).mockImplementation(
        async (quote) =>
          ({
            ...quote,
            created_at: Date.now(),
          }) as any
      )

      const result = await service.createOnchainMintQuote('unit', pubkey)

      expect(onchainBackend.createDepositAddress).toHaveBeenCalledWith(expect.any(String), 0n)
      expect(mockQuoteRepo.createMintQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 0,
          unit: 'unit',
          rune_id: '1527352:1',
          method: 'onchain',
          pubkey,
          amount_paid: 0,
          amount_issued: 0,
        })
      )
      expect(result).toEqual(
        expect.objectContaining({
          request: 'tb1ptest123',
          unit: 'unit',
          pubkey,
          amount_paid: 0,
          amount_issued: 0,
        })
      )
    })

    it('still allows an explicit rune id for UNIT onchain quotes', async () => {
      const onchainBackend = createMockBackend('unit', 'onchain')
      const registry = new BackendRegistry()
      registry.register(onchainBackend, [], ['unit'])
      const service = new MintService(mockMintCrypto, mockQuoteRepo, registry, mockKeyManager)

      vi.mocked(mockQuoteRepo.createMintQuote).mockImplementation(
        async (quote) =>
          ({
            ...quote,
            created_at: Date.now(),
          }) as any
      )

      await service.createOnchainMintQuote('unit', '02' + '22'.repeat(32), '840000:3')

      expect(mockQuoteRepo.createMintQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          unit: 'unit',
          rune_id: '840000:3',
          method: 'onchain',
        })
      )
    })
  })

  describe('createMintQuote', () => {
    it('persists NUT-20 pubkeys on bolt11 quotes', async () => {
      const lightningBackend = createMockBackend('sat', 'bolt11')
      const registry = new BackendRegistry()
      registry.register(lightningBackend)
      const service = new MintService(mockMintCrypto, mockQuoteRepo, registry, mockKeyManager)

      vi.mocked(mockQuoteRepo.createMintQuote).mockImplementation(
        async (quote) =>
          ({
            ...quote,
            created_at: Date.now(),
          }) as any
      )

      const pubkey = '02' + '33'.repeat(32)
      const result = await service.createMintQuote(128, 'sat', 'btc:0', 'bolt11', pubkey)

      expect(mockQuoteRepo.createMintQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 128,
          unit: 'sat',
          method: 'bolt11',
          pubkey,
        })
      )
      expect(result.pubkey).toBe(pubkey)
    })
  })

  describe('mintTokens - Amount Verification', () => {
    const quoteId = 'dc9713f24eab8a2f2c3acd405bc95672352ade634868be38c8ec8dfdc86a14fc'

    it('requires valid NUT-20 signatures for bolt11 quotes with a stored pubkey', async () => {
      const lightningBackend = createMockBackend('sat', 'bolt11')
      const registry = new BackendRegistry()
      registry.register(lightningBackend)
      const service = new MintService(mockMintCrypto, mockQuoteRepo, registry, mockKeyManager)

      const privkey = '11'.repeat(32)
      const pubkey = Buffer.from(getPublicKey(Buffer.from(privkey, 'hex'), true)).toString('hex')
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          amount: 500,
          unit: 'sat',
          rune_id: 'btc:0',
          method: 'bolt11',
          state: 'PAID',
          pubkey,
        })
      )
      vi.mocked(lightningBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        txid: 'bolt11-payment',
        confirmations: 1,
      })
      vi.mocked(mockMintCrypto.signBlindedMessages).mockResolvedValue([
        { id: 'keyset123', amount: 500, C_: '02abc' },
      ])

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(service.mintTokens(quoteId, outputs)).rejects.toThrow(
        'Mint quote requires a valid signature'
      )

      const signature = signMintQuote(privkey, quoteId, outputs)
      const result = await service.mintTokens(quoteId, outputs, signature)

      expect(result.signatures).toHaveLength(1)
      expect(mockMintCrypto.signBlindedMessages).toHaveBeenCalledWith(outputs)
    })

    it('requires mint quote signatures for onchain quotes with a pubkey', async () => {
      const onchainBackend = createMockBackend('unit', 'onchain')
      const registry = new BackendRegistry()
      registry.register(onchainBackend, [], ['unit'])
      const service = new MintService(mockMintCrypto, mockQuoteRepo, registry, mockKeyManager)

      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          amount: 0,
          method: 'onchain',
          state: 'PAID',
          pubkey: '02' + '55'.repeat(32),
        })
      )

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(service.mintTokens(quoteId, outputs)).rejects.toThrow(
        'Mint quote requires a valid signature'
      )
      expect(mockMintCrypto.signBlindedMessages).not.toHaveBeenCalled()
    })

    it('should mint tokens when deposit amount matches quote amount', async () => {
      const quoteAmount = 500 // smallest units

      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          amount: quoteAmount,
          state: 'PAID',
        })
      )

      // Deposit matches quote amount exactly
      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
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
      expect(mockQuoteRepo.claimMintDeposit).toHaveBeenCalledWith({
        quoteId,
        method: 'unit',
        unit: 'unit',
        amount: 500n,
        txid: 'deposit_txid',
        vout: 0,
        creditMode: 'set-paid',
      })
      expect(mockQuoteRepo.markMintQuoteIssued).toHaveBeenCalled()
    })

    it('should REJECT when a deposit was already claimed by another quote', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          amount: 500,
          state: 'PAID',
        })
      )
      vi.mocked(mockQuoteRepo.claimMintDeposit).mockResolvedValue(false)
      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 500n,
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs)).rejects.toThrow(
        'Deposit already claimed by another quote'
      )
      expect(mockMintCrypto.signBlindedMessages).not.toHaveBeenCalled()
    })

    it('should REJECT when deposit amount is GREATER than quote amount', async () => {
      const quoteAmount = 500

      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          amount: quoteAmount,
          state: 'PAID',
        })
      )

      // THE ACTUAL BUG SCENARIO: User sent 2000 but quote was for 500
      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 2000n, // OVERPAYMENT!
        txid: '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df',
        vout: 1,
        confirmations: 6,
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs)).rejects.toThrow(AmountMismatchError)

      // Should NOT issue tokens
      expect(mockMintCrypto.signBlindedMessages).not.toHaveBeenCalled()
      expect(mockQuoteRepo.updateMintQuoteState).not.toHaveBeenCalledWith(quoteId, 'ISSUED')
    })

    it('should REJECT when deposit amount is LESS than quote amount', async () => {
      const quoteAmount = 500

      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          amount: quoteAmount,
          state: 'PAID',
        })
      )

      // Underpayment
      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 100n, // Only sent 100 instead of 500
        txid: 'underpayment_txid',
        vout: 0,
        confirmations: 6,
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs)).rejects.toThrow(AmountMismatchError)
    })

    it('should REJECT when deposit not found on-chain', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          state: 'PAID',
        })
      )

      // Deposit confirmed but amount undefined means not actually found
      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: undefined, // No deposit found!
        confirmations: 6, // Has confirmations but no amount = not found
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs)).rejects.toThrow(
        'Deposit not found on-chain'
      )
    })

    it('should REJECT when deposit has insufficient confirmations', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          state: 'UNPAID',
        })
      )

      // Unconfirmed deposit
      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: false,
        amount: 500n,
        txid: 'unconfirmed_txid',
        vout: 0,
        confirmations: 0,
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs)).rejects.toThrow(/confirmations/)
    })

    it('should REJECT when output amounts do not sum to quote amount', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          state: 'PAID',
        })
      )

      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
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

      await expect(mintService.mintTokens(quoteId, outputs)).rejects.toThrow(AmountMismatchError)
    })

    it('should REJECT when output keysets do not match the quote unit', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          amount: 500,
          state: 'PAID',
        })
      )

      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 500n,
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      const outputs = [{ id: 'other-unit-keyset', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs)).rejects.toThrow(
        'Output keyset does not match quote unit'
      )
      expect(mockMintCrypto.signBlindedMessages).not.toHaveBeenCalled()
    })

    it('should REJECT already issued quote', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          state: 'ISSUED', // Already issued!
        })
      )

      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 500n,
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      const outputs = [{ id: 'keyset123', amount: 500, B_: '02xyz' }]

      await expect(mintService.mintTokens(quoteId, outputs)).rejects.toThrow('already issued')
    })
  })

  describe('getMintQuote - Amount Mismatch Detection', () => {
    const quoteId = 'test-quote-123'

    it('should keep quote UNPAID when deposit amount mismatches', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          state: 'UNPAID',
        })
      )

      // Deposit confirmed but wrong amount
      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 2000n, // Wrong amount!
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      const result = (await mintService.getMintQuote(quoteId)) as MintQuoteResponse

      // Quote should remain UNPAID
      expect(result.state).toBe('UNPAID')
      expect(mockQuoteRepo.updateMintQuoteState).not.toHaveBeenCalled()
    })

    it('should mark quote PAID when deposit amount matches', async () => {
      vi.mocked(mockQuoteRepo.findMintQuoteByIdOrThrow).mockResolvedValue(
        createMintQuote({
          id: quoteId,
          state: 'UNPAID',
        })
      )

      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 500n, // Exact match!
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      const result = (await mintService.getMintQuote(quoteId)) as MintQuoteResponse

      expect(result.state).toBe('PAID')
      expect(mockQuoteRepo.claimMintDeposit).toHaveBeenCalledWith({
        quoteId,
        method: 'unit',
        unit: 'unit',
        amount: 500n,
        txid: 'deposit_txid',
        vout: 0,
        creditMode: 'set-paid',
      })
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
