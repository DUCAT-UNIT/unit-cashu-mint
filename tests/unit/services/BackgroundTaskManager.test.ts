import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { BackgroundTaskManager } from '../../../src/services/BackgroundTaskManager.js'
import { BackendRegistry } from '../../../src/core/payment/BackendRegistry.js'
import { IPaymentBackend } from '../../../src/core/payment/types.js'
import { QuoteRepository } from '../../../src/database/repositories/QuoteRepository.js'

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
    syncUtxos: vi.fn().mockResolvedValue(undefined),
  }
}

describe('BackgroundTaskManager', () => {
  let backgroundTaskManager: BackgroundTaskManager
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
    if (backgroundTaskManager) {
      backgroundTaskManager.stop()
    }
    vi.clearAllTimers()
  })

  describe('start/stop', () => {
    it('should start all background tasks', () => {
      vi.useFakeTimers()
      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)

      backgroundTaskManager.start()
      const status = backgroundTaskManager.getStatus()

      expect(status.isStarted).toBe(true)
      expect(status.depositMonitor.isRunning).toBe(true)
      expect(status.utxoSync.isRunning).toBe(true)

      vi.useRealTimers()
    })

    it('should not start if already running', () => {
      vi.useFakeTimers()
      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)

      backgroundTaskManager.start()
      backgroundTaskManager.start() // Second start should be ignored

      const status = backgroundTaskManager.getStatus()
      expect(status.isStarted).toBe(true)

      vi.useRealTimers()
    })

    it('should stop all background tasks', () => {
      vi.useFakeTimers()
      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)

      backgroundTaskManager.start()
      backgroundTaskManager.stop()

      const status = backgroundTaskManager.getStatus()
      expect(status.isStarted).toBe(false)
      expect(status.depositMonitor.isRunning).toBe(false)
      expect(status.utxoSync.isRunning).toBe(false)

      vi.useRealTimers()
    })

    it('should not stop if not running', () => {
      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)

      // Should not throw
      expect(() => backgroundTaskManager.stop()).not.toThrow()
    })
  })

  describe('getStatus', () => {
    it('should return status of all tasks', () => {
      vi.useFakeTimers()
      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)

      const statusBefore = backgroundTaskManager.getStatus()
      expect(statusBefore.isStarted).toBe(false)
      expect(statusBefore.depositMonitor.isRunning).toBe(false)
      expect(statusBefore.utxoSync.isRunning).toBe(false)

      backgroundTaskManager.start()

      const statusAfter = backgroundTaskManager.getStatus()
      expect(statusAfter.isStarted).toBe(true)
      expect(statusAfter.depositMonitor.isRunning).toBe(true)
      expect(statusAfter.utxoSync.isRunning).toBe(true)

      // Verify config is included
      expect(statusAfter.depositMonitor.config).toBeDefined()
      expect(statusAfter.depositMonitor.config.pollInterval).toBe(30_000)
      expect(statusAfter.utxoSync.config).toBeDefined()
      expect(statusAfter.utxoSync.config.syncInterval).toBe(5 * 60 * 1000)

      vi.useRealTimers()
    })
  })

  describe('triggerUtxoSync', () => {
    it('should manually trigger UTXO sync', async () => {
      vi.useFakeTimers()

      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)
      backgroundTaskManager.start()

      // Clear initial sync calls
      await vi.advanceTimersByTimeAsync(10)
      vi.mocked(mockBackend.syncUtxos!).mockClear()

      // Manually trigger
      await backgroundTaskManager.triggerUtxoSync()

      expect(mockBackend.syncUtxos).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })

    it('should throw if tasks not started', async () => {
      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)

      await expect(backgroundTaskManager.triggerUtxoSync()).rejects.toThrow(
        'UtxoSyncService is not running'
      )
    })
  })

  describe('integration', () => {
    it('should coordinate both services correctly', async () => {
      vi.useFakeTimers()

      vi.spyOn(quoteRepo, 'findMintQuotesByState').mockResolvedValue([])

      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)
      backgroundTaskManager.start()

      // Both should run initially
      await vi.advanceTimersByTimeAsync(100)

      // UTXO sync should have run
      expect(mockBackend.syncUtxos).toHaveBeenCalled()

      // Deposit monitor polls more frequently (30s vs 5min)
      const initialCheckCalls = vi.mocked(mockBackend.checkDeposit).mock.calls.length

      // Advance by 30 seconds - deposit monitor should run again
      await vi.advanceTimersByTimeAsync(30_000)

      // UTXO sync should not have run again (needs 5 minutes)
      expect(mockBackend.syncUtxos).toHaveBeenCalledTimes(1)

      // Stop should cleanly stop both services
      backgroundTaskManager.stop()

      const status = backgroundTaskManager.getStatus()
      expect(status.depositMonitor.isRunning).toBe(false)
      expect(status.utxoSync.isRunning).toBe(false)

      vi.useRealTimers()
    })

    it('should handle errors in one service without affecting the other', async () => {
      vi.useFakeTimers()

      // Make deposit monitor fail
      vi.spyOn(quoteRepo, 'findMintQuotesByState').mockRejectedValue(
        new Error('Database error')
      )

      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)
      backgroundTaskManager.start()

      await vi.advanceTimersByTimeAsync(100)

      // UTXO sync should still have run despite deposit monitor error
      expect(mockBackend.syncUtxos).toHaveBeenCalled()

      // Both should still be running
      const status = backgroundTaskManager.getStatus()
      expect(status.depositMonitor.isRunning).toBe(true)
      expect(status.utxoSync.isRunning).toBe(true)

      vi.useRealTimers()
    })
  })

  describe('lifecycle', () => {
    it('should allow restart after stop', () => {
      vi.useFakeTimers()
      backgroundTaskManager = new BackgroundTaskManager(backendRegistry, quoteRepo)

      // Start
      backgroundTaskManager.start()
      expect(backgroundTaskManager.getStatus().isStarted).toBe(true)

      // Stop
      backgroundTaskManager.stop()
      expect(backgroundTaskManager.getStatus().isStarted).toBe(false)

      // Restart
      backgroundTaskManager.start()
      expect(backgroundTaskManager.getStatus().isStarted).toBe(true)

      vi.useRealTimers()
    })
  })
})
