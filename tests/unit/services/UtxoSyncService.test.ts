import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { UtxoSyncService } from '../../../src/services/UtxoSyncService.js'
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

// Mock backend with syncUtxos capability
function createMockBackend(unit: string): IPaymentBackend {
  return {
    unit,
    createDepositAddress: vi.fn(),
    checkDeposit: vi.fn(),
    verifySpecificDeposit: vi.fn(),
    estimateFee: vi.fn(),
    withdraw: vi.fn(),
    getBalance: vi.fn(),
    syncUtxos: vi.fn().mockResolvedValue(undefined),
  }
}

describe('UtxoSyncService', () => {
  let utxoSyncService: UtxoSyncService
  let backendRegistry: BackendRegistry
  let mockBackend: IPaymentBackend

  beforeEach(() => {
    backendRegistry = new BackendRegistry()
    mockBackend = createMockBackend('sat')
    backendRegistry.register(mockBackend)
  })

  afterEach(() => {
    if (utxoSyncService) {
      utxoSyncService.stop()
    }
    vi.clearAllTimers()
  })

  describe('start/stop', () => {
    it('should start syncing', () => {
      vi.useFakeTimers()
      utxoSyncService = new UtxoSyncService(backendRegistry, {
        syncInterval: 1000,
      })

      utxoSyncService.start()
      const status = utxoSyncService.getStatus()

      expect(status.isRunning).toBe(true)
      expect(status.config.syncInterval).toBe(1000)

      vi.useRealTimers()
    })

    it('should not start if already running', () => {
      vi.useFakeTimers()
      utxoSyncService = new UtxoSyncService(backendRegistry)

      utxoSyncService.start()
      utxoSyncService.start() // Second start should be ignored

      const status = utxoSyncService.getStatus()
      expect(status.isRunning).toBe(true)

      vi.useRealTimers()
    })

    it('should stop syncing', () => {
      vi.useFakeTimers()
      utxoSyncService = new UtxoSyncService(backendRegistry)

      utxoSyncService.start()
      utxoSyncService.stop()

      const status = utxoSyncService.getStatus()
      expect(status.isRunning).toBe(false)

      vi.useRealTimers()
    })

    it('should not stop if not running', () => {
      utxoSyncService = new UtxoSyncService(backendRegistry)

      // Should not throw
      expect(() => utxoSyncService.stop()).not.toThrow()
    })
  })

  describe('UTXO syncing', () => {
    it('should sync UTXOs immediately on start', async () => {
      utxoSyncService = new UtxoSyncService(backendRegistry, {
        syncInterval: 5000,
      })

      utxoSyncService.start()

      // Wait for initial sync to complete
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(mockBackend.syncUtxos).toHaveBeenCalled()
    })

    it('should sync UTXOs periodically', async () => {
      vi.useFakeTimers()

      utxoSyncService = new UtxoSyncService(backendRegistry, {
        syncInterval: 1000,
      })

      utxoSyncService.start()

      // Initial sync
      await vi.advanceTimersByTimeAsync(10)
      expect(mockBackend.syncUtxos).toHaveBeenCalledTimes(1)

      // First interval sync
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockBackend.syncUtxos).toHaveBeenCalledTimes(2)

      // Second interval sync
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockBackend.syncUtxos).toHaveBeenCalledTimes(3)

      vi.useRealTimers()
    })

    it('should continue syncing even if sync fails', async () => {
      vi.useFakeTimers()
      let callCount = 0
      vi.mocked(mockBackend.syncUtxos!).mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('Sync failed')
        }
      })

      utxoSyncService = new UtxoSyncService(backendRegistry, {
        syncInterval: 1000,
      })

      utxoSyncService.start()

      // Initial sync (will fail)
      await vi.advanceTimersByTimeAsync(10)
      expect(mockBackend.syncUtxos).toHaveBeenCalledTimes(1)

      // Should continue with next sync despite error
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockBackend.syncUtxos).toHaveBeenCalledTimes(2)

      // Still running
      expect(utxoSyncService.getStatus().isRunning).toBe(true)

      vi.useRealTimers()
    })

    it('should sync all backends with syncUtxos', async () => {
      const btcBackend = createMockBackend('btc')
      backendRegistry.register(btcBackend)

      utxoSyncService = new UtxoSyncService(backendRegistry, {
        syncInterval: 5000,
      })

      utxoSyncService.start()

      // Wait for initial sync to complete
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(mockBackend.syncUtxos).toHaveBeenCalled()
      expect(btcBackend.syncUtxos).toHaveBeenCalled()
    })
  })

  describe('triggerSync', () => {
    it('should manually trigger a sync', async () => {
      vi.useFakeTimers()

      utxoSyncService = new UtxoSyncService(backendRegistry)
      utxoSyncService.start()

      // Clear the initial automatic sync
      await vi.advanceTimersByTimeAsync(10)
      vi.mocked(mockBackend.syncUtxos!).mockClear()

      // Manually trigger
      await utxoSyncService.triggerSync()

      expect(mockBackend.syncUtxos).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })

    it('should throw if not running', async () => {
      utxoSyncService = new UtxoSyncService(backendRegistry)

      await expect(utxoSyncService.triggerSync()).rejects.toThrow(
        'UtxoSyncService is not running'
      )
    })
  })

  describe('getStatus', () => {
    it('should return correct status', () => {
      utxoSyncService = new UtxoSyncService(backendRegistry, {
        syncInterval: 10000,
      })

      const status = utxoSyncService.getStatus()

      expect(status.isRunning).toBe(false)
      expect(status.config.syncInterval).toBe(10000)
    })

    it('should show running status after start', () => {
      vi.useFakeTimers()
      utxoSyncService = new UtxoSyncService(backendRegistry)

      utxoSyncService.start()
      const status = utxoSyncService.getStatus()

      expect(status.isRunning).toBe(true)

      vi.useRealTimers()
    })
  })

  describe('default configuration', () => {
    it('should use default sync interval', () => {
      utxoSyncService = new UtxoSyncService(backendRegistry)

      const status = utxoSyncService.getStatus()

      expect(status.config.syncInterval).toBe(5 * 60 * 1000) // 5 minutes
    })

    it('should allow partial config override', () => {
      utxoSyncService = new UtxoSyncService(backendRegistry, {
        syncInterval: 60000,
      })

      const status = utxoSyncService.getStatus()

      expect(status.config.syncInterval).toBe(60000)
    })
  })
})
