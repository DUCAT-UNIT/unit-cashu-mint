import { describe, expect, it, vi } from 'vitest'
import { MeltService } from '../../../src/core/services/MeltService.js'
import { MintCrypto } from '../../../src/core/crypto/MintCrypto.js'
import { QuoteRepository } from '../../../src/database/repositories/QuoteRepository.js'
import { ProofRepository } from '../../../src/database/repositories/ProofRepository.js'
import { BackendRegistry } from '../../../src/core/payment/BackendRegistry.js'
import { IPaymentBackend } from '../../../src/core/payment/types.js'

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
    const service = new MeltService(
      {} as MintCrypto,
      quoteRepo,
      {} as ProofRepository,
      registry
    )

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
})
