import { RunesBackend } from '../runes/RunesBackend.js'
import { logger } from '../utils/logger.js'

export interface UtxoSyncConfig {
  syncInterval: number // milliseconds
}

const DEFAULT_CONFIG: UtxoSyncConfig = {
  syncInterval: 5 * 60 * 1000, // 5 minutes
}

/**
 * Background service that periodically syncs UTXOs from the blockchain
 * Ensures the mint's UTXO database is up-to-date with new deposits
 */
export class UtxoSyncService {
  private config: UtxoSyncConfig
  private isRunning = false
  private intervalId: NodeJS.Timeout | null = null

  constructor(
    private runesBackend: RunesBackend,
    config?: Partial<UtxoSyncConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Start the UTXO sync service
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('UtxoSyncService is already running')
      return
    }

    this.isRunning = true
    logger.info(
      {
        syncInterval: this.config.syncInterval,
      },
      'Starting UTXO sync service'
    )

    // Run immediately on start
    this.syncUtxos().catch((error) => {
      logger.error({ error }, 'Error in initial UTXO sync')
    })

    // Then run on interval
    this.intervalId = setInterval(() => {
      this.syncUtxos().catch((error) => {
        logger.error({ error }, 'Error in periodic UTXO sync')
      })
    }, this.config.syncInterval)
  }

  /**
   * Stop the UTXO sync service
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn('UtxoSyncService is not running')
      return
    }

    this.isRunning = false

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    logger.info('UTXO sync service stopped')
  }

  /**
   * Sync UTXOs from blockchain
   */
  private async syncUtxos(): Promise<void> {
    try {
      const startTime = Date.now()

      logger.info('Syncing UTXOs from blockchain')

      await this.runesBackend.syncUtxos()

      const duration = Date.now() - startTime

      logger.info(
        { duration },
        'UTXO sync completed'
      )
    } catch (error) {
      logger.error({ error }, 'Error syncing UTXOs')
      throw error
    }
  }

  /**
   * Manually trigger a sync (for testing or admin purposes)
   */
  async triggerSync(): Promise<void> {
    if (!this.isRunning) {
      throw new Error('UtxoSyncService is not running')
    }

    await this.syncUtxos()
  }

  /**
   * Get the current status of the service
   */
  getStatus(): {
    isRunning: boolean
    config: UtxoSyncConfig
  } {
    return {
      isRunning: this.isRunning,
      config: this.config,
    }
  }
}
