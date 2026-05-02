import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { DepositMonitor } from '../../../src/services/DepositMonitor.js'
import { BackendRegistry } from '../../../src/core/payment/BackendRegistry.js'
import { IPaymentBackend } from '../../../src/core/payment/types.js'
import { QuoteRepository } from '../../../src/database/repositories/QuoteRepository.js'
import { MintQuote } from '../../../src/core/models/Quote.js'
import { MintQuoteState } from '../../../src/types/cashu.js'

// Mock dependencies
vi.mock('../../../src/database/db.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getPool: vi.fn(),
}))

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// Mock backend for testing
function createMockBackend(unit: string): IPaymentBackend {
  return {
    unit,
    createDepositAddress: vi.fn(),
    checkDeposit: vi.fn().mockResolvedValue({ confirmed: false, confirmations: 0 }),
    verifySpecificDeposit: vi.fn(),
    estimateFee: vi.fn(),
    withdraw: vi.fn(),
    getBalance: vi.fn(),
  }
}

describe('DepositMonitor', () => {
  let depositMonitor: DepositMonitor
  let backendRegistry: BackendRegistry
  let mockBackend: IPaymentBackend
  let quoteRepo: QuoteRepository

  beforeEach(() => {
    backendRegistry = new BackendRegistry()
    mockBackend = createMockBackend('sat')
    backendRegistry.register(mockBackend)
    quoteRepo = new QuoteRepository()
  })

  afterEach(() => {
    if (depositMonitor) {
      depositMonitor.stop()
    }
    vi.clearAllTimers()
  })

  describe('start/stop', () => {
    it('should start monitoring', () => {
      vi.useFakeTimers()
      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo, {
        pollInterval: 1000,
        batchSize: 50,
        maxAge: 3600,
      })

      depositMonitor.start()
      const status = depositMonitor.getStatus()

      expect(status.isRunning).toBe(true)
      expect(status.config.pollInterval).toBe(1000)

      vi.useRealTimers()
    })

    it('should not start if already running', () => {
      vi.useFakeTimers()
      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo)

      depositMonitor.start()
      depositMonitor.start() // Second start should be ignored

      const status = depositMonitor.getStatus()
      expect(status.isRunning).toBe(true)

      vi.useRealTimers()
    })

    it('should stop monitoring', () => {
      vi.useFakeTimers()
      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo)

      depositMonitor.start()
      depositMonitor.stop()

      const status = depositMonitor.getStatus()
      expect(status.isRunning).toBe(false)

      vi.useRealTimers()
    })
  })

  describe('deposit detection', () => {
    it('should detect confirmed deposits and update quote state', async () => {
      const now = Date.now()
      const mockQuote: MintQuote = {
        id: 'quote1',
        amount: 100n,
        unit: 'sat',
        rune_id: '1527352:1',
        method: 'unit',
        request: 'tb1ptest123',
        state: 'UNPAID' as MintQuoteState,
        expiry: Math.floor(now / 1000) + 600, // expiry is in seconds
        created_at: now,
      }

      // Mock the repo to return our pending quote
      vi.spyOn(quoteRepo, 'findMintQuotesByState').mockResolvedValue([mockQuote])
      const claimSpy = vi.spyOn(quoteRepo, 'claimMintDeposit').mockResolvedValue(true)

      // Simulate a confirmed deposit
      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: true,
        amount: 100n,
        txid: 'deposit_txid',
        vout: 0,
        confirmations: 6,
      })

      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo, {
        pollInterval: 100,
        batchSize: 50,
        maxAge: 3600,
      })

      depositMonitor.start()

      // Wait for the async check to complete (don't use fake timers)
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify the UTXO was atomically claimed before the quote was credited.
      expect(claimSpy).toHaveBeenCalledWith({
        quoteId: 'quote1',
        method: 'unit',
        unit: 'sat',
        amount: 100n,
        txid: 'deposit_txid',
        vout: 0,
        creditMode: 'set-paid',
      })
    })

    it('should not update quote if deposit not confirmed', async () => {
      const now = Date.now()
      const mockQuote: MintQuote = {
        id: 'quote2',
        amount: 100n,
        unit: 'sat',
        rune_id: '1527352:1',
        request: 'tb1ptest456',
        state: 'UNPAID' as MintQuoteState,
        expiry: Math.floor(now / 1000) + 600,
        created_at: now,
      }

      vi.spyOn(quoteRepo, 'findMintQuotesByState').mockResolvedValue([mockQuote])
      const updateSpy = vi.spyOn(quoteRepo, 'updateMintQuoteState').mockResolvedValue()
      const claimSpy = vi.spyOn(quoteRepo, 'claimMintDeposit').mockResolvedValue(true)

      // Return not confirmed
      vi.mocked(mockBackend.checkDeposit).mockResolvedValue({
        confirmed: false,
        confirmations: 0,
      })

      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo, {
        pollInterval: 100,
        batchSize: 50,
        maxAge: 3600,
      })

      depositMonitor.start()

      // Wait for async check
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Verify the quote state was NOT updated
      expect(updateSpy).not.toHaveBeenCalled()
      expect(claimSpy).not.toHaveBeenCalled()
    })

    it('should filter out expired quotes', async () => {
      const now = Date.now()
      const nowSec = Math.floor(now / 1000)

      const expiredQuote: MintQuote = {
        id: 'expired1',
        amount: 100n,
        unit: 'sat',
        rune_id: '1527352:1',
        request: 'tb1pexpired',
        state: 'UNPAID' as MintQuoteState,
        expiry: nowSec - 10, // Already expired (10 seconds ago)
        created_at: now - 10000,
      }

      const validQuote: MintQuote = {
        id: 'valid1',
        amount: 100n,
        unit: 'sat',
        rune_id: '1527352:1',
        request: 'tb1pvalid',
        state: 'UNPAID' as MintQuoteState,
        expiry: nowSec + 600,
        created_at: now,
      }

      vi.spyOn(quoteRepo, 'findMintQuotesByState').mockResolvedValue([
        expiredQuote,
        validQuote,
      ])

      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo, {
        pollInterval: 100,
        batchSize: 50,
        maxAge: 3600,
      })

      depositMonitor.start()
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Should only check the valid quote
      expect(mockBackend.checkDeposit).toHaveBeenCalledTimes(1)
      expect(mockBackend.checkDeposit).toHaveBeenCalledWith('valid1', 'tb1pvalid', false, 100n)
    })

    it('should filter out quotes older than maxAge', async () => {
      const now = Date.now()
      const nowSec = Math.floor(now / 1000)

      const oldQuote: MintQuote = {
        id: 'old1',
        amount: 100n,
        unit: 'sat',
        rune_id: '1527352:1',
        request: 'tb1pold',
        state: 'UNPAID' as MintQuoteState,
        expiry: nowSec + 600,
        created_at: now - 25 * 60 * 60 * 1000, // 25 hours ago
      }

      const recentQuote: MintQuote = {
        id: 'recent1',
        amount: 100n,
        unit: 'sat',
        rune_id: '1527352:1',
        request: 'tb1precent',
        state: 'UNPAID' as MintQuoteState,
        expiry: nowSec + 600,
        created_at: now - 1000,
      }

      vi.spyOn(quoteRepo, 'findMintQuotesByState').mockResolvedValue([
        oldQuote,
        recentQuote,
      ])

      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo, {
        pollInterval: 100,
        batchSize: 50,
        maxAge: 24 * 60 * 60, // 24 hours in seconds
      })

      depositMonitor.start()
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Should only check the recent quote
      expect(mockBackend.checkDeposit).toHaveBeenCalledTimes(1)
      expect(mockBackend.checkDeposit).toHaveBeenCalledWith('recent1', 'tb1precent', false, 100n)
    })

    it('should use correct backend for each quote unit', async () => {
      const now = Date.now()
      const btcBackend = createMockBackend('btc')
      backendRegistry.register(btcBackend)

      const satQuote: MintQuote = {
        id: 'sat1',
        amount: 100n,
        unit: 'sat',
        rune_id: '1527352:1',
        request: 'tb1psat',
        state: 'UNPAID' as MintQuoteState,
        expiry: Math.floor(now / 1000) + 600,
        created_at: now,
      }

      const btcQuote: MintQuote = {
        id: 'btc1',
        amount: 100n,
        unit: 'btc',
        rune_id: '',
        request: 'tb1qbtc',
        state: 'UNPAID' as MintQuoteState,
        expiry: Math.floor(now / 1000) + 600,
        created_at: now,
      }

      vi.spyOn(quoteRepo, 'findMintQuotesByState').mockResolvedValue([satQuote, btcQuote])

      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo, {
        pollInterval: 100,
        batchSize: 50,
        maxAge: 3600,
      })

      depositMonitor.start()
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Each backend should have been called for its respective quote
      expect(mockBackend.checkDeposit).toHaveBeenCalledWith('sat1', 'tb1psat', false, 100n)
      expect(btcBackend.checkDeposit).toHaveBeenCalledWith('btc1', 'tb1qbtc', false, 100n)
    })
  })

  describe('error handling', () => {
    it('should continue monitoring even if checkDeposit fails', async () => {
      const now = Date.now()
      const mockQuote: MintQuote = {
        id: 'quote3',
        amount: 100n,
        unit: 'sat',
        rune_id: '1527352:1',
        request: 'tb1perror',
        state: 'UNPAID' as MintQuoteState,
        expiry: Math.floor(now / 1000) + 600,
        created_at: now,
      }

      vi.spyOn(quoteRepo, 'findMintQuotesByState').mockResolvedValue([mockQuote])
      vi.mocked(mockBackend.checkDeposit).mockRejectedValue(new Error('API error'))
      const updateSpy = vi.spyOn(quoteRepo, 'updateMintQuoteState')

      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo, {
        pollInterval: 100,
        batchSize: 50,
        maxAge: 3600,
      })

      depositMonitor.start()
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Should not have updated the quote
      expect(updateSpy).not.toHaveBeenCalled()

      // Should still be running
      expect(depositMonitor.getStatus().isRunning).toBe(true)
    })
  })

  describe('getStatus', () => {
    it('should return correct status', () => {
      depositMonitor = new DepositMonitor(backendRegistry, quoteRepo, {
        pollInterval: 5000,
        batchSize: 100,
        maxAge: 7200,
      })

      const status = depositMonitor.getStatus()

      expect(status.isRunning).toBe(false)
      expect(status.config.pollInterval).toBe(5000)
      expect(status.config.batchSize).toBe(100)
      expect(status.config.maxAge).toBe(7200)
    })
  })
})
