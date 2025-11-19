import { DepositMonitor } from './DepositMonitor.js'
import { UtxoSyncService } from './UtxoSyncService.js'
import { RunesBackend } from '../runes/RunesBackend.js'
import { QuoteRepository } from '../database/repositories/QuoteRepository.js'
import { logger } from '../utils/logger.js'

/**
 * Manages all background tasks for the mint
 * Coordinates deposit monitoring, UTXO syncing, and other periodic tasks
 */
export class BackgroundTaskManager {
  private depositMonitor: DepositMonitor
  private utxoSyncService: UtxoSyncService
  private isStarted = false

  constructor(
    runesBackend: RunesBackend,
    quoteRepo: QuoteRepository
  ) {
    // Initialize services with appropriate intervals
    this.depositMonitor = new DepositMonitor(runesBackend, quoteRepo, {
      pollInterval: 30_000, // 30 seconds - check deposits frequently
      batchSize: 50,
      maxAge: 24 * 60 * 60, // 24 hours
    })

    this.utxoSyncService = new UtxoSyncService(runesBackend, {
      syncInterval: 5 * 60 * 1000, // 5 minutes - sync UTXOs less frequently
    })
  }

  /**
   * Start all background tasks
   */
  start(): void {
    if (this.isStarted) {
      logger.warn('Background tasks are already running')
      return
    }

    logger.info('Starting background task manager')

    // Start all services
    this.depositMonitor.start()
    this.utxoSyncService.start()

    this.isStarted = true

    logger.info('All background tasks started successfully')
  }

  /**
   * Stop all background tasks
   */
  stop(): void {
    if (!this.isStarted) {
      logger.warn('Background tasks are not running')
      return
    }

    logger.info('Stopping background task manager')

    // Stop all services
    this.depositMonitor.stop()
    this.utxoSyncService.stop()

    this.isStarted = false

    logger.info('All background tasks stopped')
  }

  /**
   * Get status of all background tasks
   */
  getStatus(): {
    isStarted: boolean
    depositMonitor: ReturnType<DepositMonitor['getStatus']>
    utxoSync: ReturnType<UtxoSyncService['getStatus']>
  } {
    return {
      isStarted: this.isStarted,
      depositMonitor: this.depositMonitor.getStatus(),
      utxoSync: this.utxoSyncService.getStatus(),
    }
  }

  /**
   * Manually trigger a UTXO sync (for testing/admin)
   */
  async triggerUtxoSync(): Promise<void> {
    await this.utxoSyncService.triggerSync()
  }
}
