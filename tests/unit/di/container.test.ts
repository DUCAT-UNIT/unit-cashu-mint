import { describe, it, expect, beforeAll } from 'vitest'
import { initializeContainer } from '../../../src/di/container.js'
import { testConnection } from '../../../src/database/db.js'

describe('DI Container', () => {
  beforeAll(async () => {
    await testConnection()
  })

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
})
