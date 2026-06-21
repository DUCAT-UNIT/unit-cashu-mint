import { describe, it, expect, vi } from 'vitest'
import { initializeContainer } from '../../../src/di/container.js'

describe('DI Container', () => {
  it('should initialize container with all dependencies', () => {
    const container = initializeContainer()

    expect(container).toBeDefined()
    expect(typeof container.register).toBe('function')
    expect(typeof container.resolve).toBe('function')
  })

  it('should resolve keyManager', () => {
    const container = initializeContainer()
    const keyManager = container.resolve('keyManager')

    expect(keyManager).toBeDefined()
    expect(typeof keyManager.generateKeyset).toBe('function')
  })

  it('should resolve mintCrypto', () => {
    const container = initializeContainer()
    const mintCrypto = container.resolve('mintCrypto')

    expect(mintCrypto).toBeDefined()
    expect(typeof mintCrypto.signBlindedMessages).toBe('function')
  })

  it('should resolve mintService', () => {
    const container = initializeContainer()
    const mintService = container.resolve('mintService')

    expect(mintService).toBeDefined()
    expect(typeof mintService.createMintQuote).toBe('function')
  })

  it('should resolve swapService', () => {
    const container = initializeContainer()
    const swapService = container.resolve('swapService')

    expect(swapService).toBeDefined()
    expect(typeof swapService.swap).toBe('function')
  })

  it('should resolve meltService', () => {
    const container = initializeContainer()
    const meltService = container.resolve('meltService')

    expect(meltService).toBeDefined()
    expect(typeof meltService.createMeltQuote).toBe('function')
  })

  it('should resolve repositories', () => {
    const container = initializeContainer()

    const keysetRepo = container.resolve('keysetRepository')
    expect(keysetRepo).toBeDefined()

    const proofRepo = container.resolve('proofRepository')
    expect(proofRepo).toBeDefined()

    const quoteRepo = container.resolve('quoteRepository')
    expect(quoteRepo).toBeDefined()
  })

  it('should return same instance for multiple resolves (singleton)', () => {
    const container = initializeContainer()

    const keyManager1 = container.resolve('keyManager')
    const keyManager2 = container.resolve('keyManager')

    expect(keyManager1).toBe(keyManager2)
  })

  it('should pass configured UNIT rune metadata to the Runes backend', async () => {
    vi.resetModules()

    const mockDb = {}
    const runesBackendConstructor = vi.fn(function (
      _db: unknown,
      runeId?: string,
      runeName?: string
    ) {
      return {
        method: 'onchain',
        unit: 'unit',
        createDepositAddress: vi.fn(),
        checkDeposit: vi.fn(),
        verifySpecificDeposit: vi.fn(),
        estimateFee: vi.fn(),
        withdraw: vi.fn(),
        getRuneId: () => runeId,
        getRuneName: () => runeName,
      }
    })

    vi.doMock('../../../src/config/env.js', () => ({
      env: {
        SUPPORTED_UNITS_ARRAY: ['unit'],
        SUPPORTED_RUNES_ARRAY: ['3007902:1'],
        SUPPORTED_RUNE_NAMES_ARRAY: ['DUCAT•UNIT•MTNY'],
        SUPPORTS_BITCOIN: false,
        LIGHTNING_BACKEND: 'disabled',
      },
    }))
    vi.doMock('../../../src/database/db.js', () => ({
      getPool: vi.fn(() => mockDb),
    }))
    vi.doMock('../../../src/runes/RunesBackend.js', () => ({
      RunesBackend: runesBackendConstructor,
    }))
    vi.doMock('../../../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))

    const { initializeContainer: initializeMockedContainer } = await import(
      '../../../src/di/container.js'
    )

    const container = initializeMockedContainer()

    expect(runesBackendConstructor).toHaveBeenCalledWith(
      mockDb,
      '3007902:1',
      'DUCAT•UNIT•MTNY'
    )
    expect(container.resolve<{ getRuneId: () => string | undefined }>('runesBackend').getRuneId())
      .toBe('3007902:1')
    expect(container.resolve<{ getRuneName: () => string | undefined }>('runesBackend').getRuneName())
      .toBe('DUCAT•UNIT•MTNY')

    vi.doUnmock('../../../src/config/env.js')
    vi.doUnmock('../../../src/database/db.js')
    vi.doUnmock('../../../src/runes/RunesBackend.js')
    vi.doUnmock('../../../src/utils/logger.js')
    vi.resetModules()
  })
})
