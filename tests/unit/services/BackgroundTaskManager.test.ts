import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { BackgroundTaskManager } from '../../../src/services/BackgroundTaskManager.js'
import { MockRunesBackend } from '../../mocks/RunesBackend.mock.js'
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
  },
}))

describe('BackgroundTaskManager', () => {
  let backgroundTaskManager: BackgroundTaskManager
  let runesBackend: MockRunesBackend
  let quoteRepo: QuoteRepository

  beforeEach(() => {
    runesBackend = new MockRunesBackend()
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
      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)

      backgroundTaskManager.start()
      const status = backgroundTaskManager.getStatus()

      expect(status.isStarted).toBe(true)
      expect(status.depositMonitor.isRunning).toBe(true)
      expect(status.utxoSync.isRunning).toBe(true)

      vi.useRealTimers()
    })

    it('should not start if already running', () => {
      vi.useFakeTimers()
      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)

      backgroundTaskManager.start()
      backgroundTaskManager.start() // Second start should be ignored

      const status = backgroundTaskManager.getStatus()
      expect(status.isStarted).toBe(true)

      vi.useRealTimers()
    })

    it('should stop all background tasks', () => {
      vi.useFakeTimers()
      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)

      backgroundTaskManager.start()
      backgroundTaskManager.stop()

      const status = backgroundTaskManager.getStatus()
      expect(status.isStarted).toBe(false)
      expect(status.depositMonitor.isRunning).toBe(false)
      expect(status.utxoSync.isRunning).toBe(false)

      vi.useRealTimers()
    })

    it('should not stop if not running', () => {
      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)

      // Should not throw
      expect(() => backgroundTaskManager.stop()).not.toThrow()
    })
  })

  describe('getStatus', () => {
    it('should return status of all tasks', () => {
      vi.useFakeTimers()
      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)

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
      const syncSpy = vi.spyOn(runesBackend, 'syncUtxos').mockResolvedValue()

      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)
      backgroundTaskManager.start()

      // Clear initial sync calls
      await vi.advanceTimersByTimeAsync(10)
      syncSpy.mockClear()

      // Manually trigger
      await backgroundTaskManager.triggerUtxoSync()

      expect(syncSpy).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })

    it('should throw if tasks not started', async () => {
      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)

      await expect(backgroundTaskManager.triggerUtxoSync()).rejects.toThrow(
        'UtxoSyncService is not running'
      )
    })
  })

  describe('integration', () => {
    it('should coordinate both services correctly', async () => {
      vi.useFakeTimers()

      const depositCheckSpy = vi.spyOn(runesBackend, 'checkDeposit')
      const utxoSyncSpy = vi.spyOn(runesBackend, 'syncUtxos').mockResolvedValue()
      vi.spyOn(quoteRepo, 'findMintQuotesByState').mockResolvedValue([])

      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)
      backgroundTaskManager.start()

      // Both should run initially
      await vi.advanceTimersByTimeAsync(100)

      // UTXO sync should have run
      expect(utxoSyncSpy).toHaveBeenCalled()

      // Deposit monitor polls more frequently (30s vs 5min)
      const initialDepositCalls = depositCheckSpy.mock.calls.length

      // Advance by 30 seconds - deposit monitor should run again
      await vi.advanceTimersByTimeAsync(30_000)

      // UTXO sync should not have run again (needs 5 minutes)
      expect(utxoSyncSpy).toHaveBeenCalledTimes(1)

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

      // UTXO sync should still work
      const utxoSyncSpy = vi.spyOn(runesBackend, 'syncUtxos').mockResolvedValue()

      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)
      backgroundTaskManager.start()

      await vi.advanceTimersByTimeAsync(100)

      // UTXO sync should still have run despite deposit monitor error
      expect(utxoSyncSpy).toHaveBeenCalled()

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
      backgroundTaskManager = new BackgroundTaskManager(runesBackend, quoteRepo)

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
