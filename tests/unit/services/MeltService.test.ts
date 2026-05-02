import { describe, expect, it, vi } from 'vitest'
import { MeltService } from '../../../src/core/services/MeltService.js'
import { MintCrypto } from '../../../src/core/crypto/MintCrypto.js'
import { QuoteRepository } from '../../../src/database/repositories/QuoteRepository.js'
import { ProofRepository } from '../../../src/database/repositories/ProofRepository.js'
import { BackendRegistry } from '../../../src/core/payment/BackendRegistry.js'
import { IPaymentBackend } from '../../../src/core/payment/types.js'
import { BlindedMessage, Proof } from '../../../src/types/cashu.js'

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
    MIN_MELT_AMOUNT: 1,
    MAX_MELT_AMOUNT: 100000000,
    SUPPORTED_RUNES_ARRAY: ['1527352:1'],
  },
}))

function createMockBackend(unit: string, method: string): IPaymentBackend {
  return {
    method,
    unit,
    createDepositAddress: vi.fn(),
    checkDeposit: vi.fn(),
    verifySpecificDeposit: vi.fn(),
    estimateFee: vi.fn().mockResolvedValue(1234),
    withdraw: vi.fn(),
    getBalance: vi.fn(),
  }
}

describe('MeltService', () => {
  it('creates UNIT melt quotes with the onchain method and configured rune id', async () => {
    const quoteRepo = {
      createMeltQuote: vi.fn().mockImplementation(async (quote) => ({
        ...quote,
        created_at: Date.now(),
      })),
    } as unknown as QuoteRepository
    const registry = new BackendRegistry()
    const backend = createMockBackend('unit', 'onchain')
    registry.register(backend, [], ['unit'])
    const service = new MeltService({} as MintCrypto, quoteRepo, {} as ProofRepository, registry)

    const quotes = await service.createOnchainMeltQuotes(
      500,
      'unit',
      'tb1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
    )

    expect(backend.estimateFee).toHaveBeenCalledWith(
      'tb1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      500n
    )
    expect(quoteRepo.createMeltQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500,
        unit: 'unit',
        rune_id: '1527352:1',
        method: 'onchain',
        fee: 1234,
        estimated_blocks: 1,
      })
    )
    expect(quotes).toEqual([
      expect.objectContaining({
        amount: 500,
        unit: 'unit',
        fee: 1234,
        estimated_blocks: 1,
        state: 'UNPAID',
      }),
    ])
  })

  it('returns NUT-08 bolt11 change for unused fee reserve blanks', async () => {
    const quoteId = 'bolt11-quote'
    const quoteRepo = {
      findMeltQuoteByIdOrThrow: vi.fn().mockResolvedValue({
        id: quoteId,
        amount: 62,
        unit: 'sat',
        rune_id: 'btc:0',
        method: 'bolt11',
        request: 'lnbcrt620n1pn0r3ve',
        fee_reserve: 2,
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
      }),
      findSettledMeltQuoteByRequest: vi.fn().mockResolvedValue(null),
      updateMeltQuoteState: vi.fn(),
    } as unknown as QuoteRepository
    const proofRepo = {
      markSpent: vi.fn(),
      deleteByTransactionId: vi.fn(),
    } as unknown as ProofRepository
    const mintCrypto = {
      sumProofs: vi.fn().mockReturnValue(64),
      calculateInputFees: vi.fn().mockResolvedValue(0),
      verifyProofsOrThrow: vi.fn(),
      hashSecret: vi.fn().mockReturnValue('02' + '11'.repeat(32)),
      signBlindedMessages: vi
        .fn()
        .mockResolvedValue([{ id: 'keyset123', amount: 2, C_: '02change' }]),
    } as unknown as MintCrypto
    const registry = new BackendRegistry()
    const backend = createMockBackend('sat', 'bolt11')
    vi.mocked(backend.withdraw).mockResolvedValue({
      txid: '0'.repeat(64),
      fee_paid: 0,
    })
    registry.register(backend)
    const service = new MeltService(mintCrypto, quoteRepo, proofRepo, registry)
    const inputs: Proof[] = [{ id: 'keyset123', amount: 64, secret: 'secret', C: '02proof' }]
    const outputs: BlindedMessage[] = [
      { id: 'keyset123', amount: 0, B_: '02blank1' },
      { id: 'keyset123', amount: 0, B_: '02blank2' },
    ]

    const result = await service.meltTokens(quoteId, inputs, outputs)

    expect(mintCrypto.signBlindedMessages).toHaveBeenCalledWith([
      { id: 'keyset123', amount: 2, B_: '02blank1' },
    ])
    expect(result).toEqual(
      expect.objectContaining({
        quote: quoteId,
        state: 'PAID',
        payment_preimage: '0'.repeat(64),
        change: [{ id: 'keyset123', amount: 2, C_: '02change' }],
      })
    )
  })

  it('signs the largest representable bolt11 change when too few blanks are provided', async () => {
    const quoteId = 'bolt11-quote'
    const quoteRepo = {
      findMeltQuoteByIdOrThrow: vi.fn().mockResolvedValue({
        id: quoteId,
        amount: 10,
        unit: 'sat',
        rune_id: 'btc:0',
        method: 'bolt11',
        request: 'lnbcrt100n1pn0r3ve',
        fee_reserve: 5,
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
      }),
      findSettledMeltQuoteByRequest: vi.fn().mockResolvedValue(null),
      updateMeltQuoteState: vi.fn(),
    } as unknown as QuoteRepository
    const proofRepo = {
      markSpent: vi.fn(),
      deleteByTransactionId: vi.fn(),
    } as unknown as ProofRepository
    const mintCrypto = {
      sumProofs: vi.fn().mockReturnValue(25),
      calculateInputFees: vi.fn().mockResolvedValue(0),
      verifyProofsOrThrow: vi.fn(),
      hashSecret: vi.fn().mockReturnValue('02' + '11'.repeat(32)),
      signBlindedMessages: vi
        .fn()
        .mockResolvedValue([{ id: 'keyset123', amount: 8, C_: '02change' }]),
    } as unknown as MintCrypto
    const registry = new BackendRegistry()
    const backend = createMockBackend('sat', 'bolt11')
    vi.mocked(backend.withdraw).mockResolvedValue({
      txid: '0'.repeat(64),
      fee_paid: 0,
    })
    registry.register(backend)
    const service = new MeltService(mintCrypto, quoteRepo, proofRepo, registry)

    const result = await service.meltTokens(
      quoteId,
      [{ id: 'keyset123', amount: 25, secret: 'secret', C: '02proof' }],
      [{ id: 'keyset123', amount: 0, B_: '02blank1' }]
    )

    expect(mintCrypto.signBlindedMessages).toHaveBeenCalledWith([
      { id: 'keyset123', amount: 8, B_: '02blank1' },
    ])
    expect(result).toEqual(
      expect.objectContaining({
        change: [{ id: 'keyset123', amount: 8, C_: '02change' }],
      })
    )
  })

  it('overrides nonzero NUT-08 change output amounts with actual denominations', async () => {
    const quoteId = 'bolt11-quote'
    const quoteRepo = {
      findMeltQuoteByIdOrThrow: vi.fn().mockResolvedValue({
        id: quoteId,
        amount: 9,
        unit: 'sat',
        rune_id: 'btc:0',
        method: 'bolt11',
        request: 'lnbcrt90n1pn0r3ve',
        fee_reserve: 2,
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
      }),
      findSettledMeltQuoteByRequest: vi.fn().mockResolvedValue(null),
      updateMeltQuoteState: vi.fn(),
    } as unknown as QuoteRepository
    const proofRepo = {
      markSpent: vi.fn(),
      deleteByTransactionId: vi.fn(),
    } as unknown as ProofRepository
    const mintCrypto = {
      sumProofs: vi.fn().mockReturnValue(100),
      calculateInputFees: vi.fn().mockResolvedValue(2),
      verifyProofsOrThrow: vi.fn(),
      hashSecret: vi.fn().mockReturnValue('02' + '11'.repeat(32)),
      signBlindedMessages: vi.fn().mockResolvedValue([
        { id: 'keyset123', amount: 64, C_: '02change64' },
        { id: 'keyset123', amount: 16, C_: '02change16' },
        { id: 'keyset123', amount: 8, C_: '02change8' },
      ]),
    } as unknown as MintCrypto
    const registry = new BackendRegistry()
    const backend = createMockBackend('sat', 'bolt11')
    vi.mocked(backend.withdraw).mockResolvedValue({
      txid: '0'.repeat(64),
      fee_paid: 1,
    })
    registry.register(backend)
    const service = new MeltService(mintCrypto, quoteRepo, proofRepo, registry)

    const result = await service.meltTokens(
      quoteId,
      [{ id: 'keyset123', amount: 100, secret: 'secret', C: '02proof' }],
      [
        { id: 'keyset123', amount: 4, B_: '02blank1' },
        { id: 'keyset123', amount: 32, B_: '02blank2' },
        { id: 'keyset123', amount: 64, B_: '02blank3' },
      ]
    )

    expect(mintCrypto.signBlindedMessages).toHaveBeenCalledWith([
      { id: 'keyset123', amount: 64, B_: '02blank1' },
      { id: 'keyset123', amount: 16, B_: '02blank2' },
      { id: 'keyset123', amount: 8, B_: '02blank3' },
    ])
    expect(result).toEqual(
      expect.objectContaining({
        change: [
          { id: 'keyset123', amount: 64, C_: '02change64' },
          { id: 'keyset123', amount: 16, C_: '02change16' },
          { id: 'keyset123', amount: 8, C_: '02change8' },
        ],
      })
    )
  })

  it('rejects a bolt11 melt when the request was already settled by another quote', async () => {
    const quoteId = 'second-quote'
    const quoteRepo = {
      findMeltQuoteByIdOrThrow: vi.fn().mockResolvedValue({
        id: quoteId,
        amount: 10,
        unit: 'sat',
        rune_id: 'btc:0',
        method: 'bolt11',
        request: 'lnbcrt100n1pn0r3ve',
        fee_reserve: 2,
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
      }),
      findSettledMeltQuoteByRequest: vi.fn().mockResolvedValue({
        id: 'first-quote',
        amount: 10,
        unit: 'sat',
        rune_id: 'btc:0',
        method: 'bolt11',
        request: 'lnbcrt100n1pn0r3ve',
        fee_reserve: 2,
        state: 'PAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        created_at: Date.now(),
      }),
      updateMeltQuoteState: vi.fn(),
    } as unknown as QuoteRepository
    const proofRepo = {
      markSpent: vi.fn(),
      deleteByTransactionId: vi.fn(),
    } as unknown as ProofRepository
    const mintCrypto = {
      sumProofs: vi.fn(),
      calculateInputFees: vi.fn(),
      verifyProofsOrThrow: vi.fn(),
      hashSecret: vi.fn(),
      signBlindedMessages: vi.fn(),
    } as unknown as MintCrypto
    const registry = new BackendRegistry()
    const backend = createMockBackend('sat', 'bolt11')
    registry.register(backend)
    const service = new MeltService(mintCrypto, quoteRepo, proofRepo, registry)

    await expect(
      service.meltTokens(
        quoteId,
        [{ id: 'keyset123', amount: 12, secret: 'secret', C: '02proof' }],
        []
      )
    ).rejects.toMatchObject({
      code: 20006,
      message: 'Request already paid',
    })

    expect(backend.withdraw).not.toHaveBeenCalled()
    expect(proofRepo.markSpent).not.toHaveBeenCalled()
  })
})
