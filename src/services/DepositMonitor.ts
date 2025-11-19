import { RunesBackend } from '../runes/RunesBackend.js'
import { QuoteRepository } from '../database/repositories/QuoteRepository.js'
import { logger } from '../utils/logger.js'
import { env } from '../config/env.js'

export interface DepositMonitorConfig {
  pollInterval: number // milliseconds
  batchSize: number // number of quotes to check per batch
  maxAge: number // maximum age of quotes to check (in seconds)
}

const DEFAULT_CONFIG: DepositMonitorConfig = {
  pollInterval: 30_000, // 30 seconds
  batchSize: 50, // check up to 50 quotes per batch
  maxAge: 24 * 60 * 60, // 24 hours
}

/**
 * Background service that monitors for Runes deposits
 * Automatically updates quote states when deposits are confirmed
 */
export class DepositMonitor {
  private config: DepositMonitorConfig
  private isRunning = false
  private intervalId: NodeJS.Timeout | null = null

  constructor(
    private runesBackend: RunesBackend,
    private quoteRepo: QuoteRepository,
    config?: Partial<DepositMonitorConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Start the deposit monitoring service
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('DepositMonitor is already running')
      return
    }

    this.isRunning = true
    logger.info(
      {
        pollInterval: this.config.pollInterval,
        batchSize: this.config.batchSize,
        maxAge: this.config.maxAge,
      },
      'Starting deposit monitor'
    )

    // Run immediately
    this.checkPendingDeposits().catch((error) => {
      logger.error({ error }, 'Error in initial deposit check')
    })

    // Then run on interval
    this.intervalId = setInterval(() => {
      this.checkPendingDeposits().catch((error) => {
        logger.error({ error }, 'Error in periodic deposit check')
      })
    }, this.config.pollInterval)
  }

  /**
   * Stop the deposit monitoring service
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn('DepositMonitor is not running')
      return
    }

    this.isRunning = false

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    logger.info('Deposit monitor stopped')
  }

  /**
   * Check all pending mint quotes for deposits
   */
  private async checkPendingDeposits(): Promise<void> {
    try {
      const startTime = Date.now()

      // Get UNPAID quotes that haven't expired yet
      const now = Math.floor(Date.now() / 1000)
      const minExpiry = now // Only check quotes that haven't expired
      const maxCreatedAt = Date.now() - this.config.maxAge * 1000

      const pendingQuotes = await this.quoteRepo.findMintQuotesByState(
        'UNPAID',
        this.config.batchSize
      )

      // Filter by age
      const quotesToCheck = pendingQuotes.filter((quote) => {
        return quote.expiry >= minExpiry && quote.created_at >= maxCreatedAt
      })

      if (quotesToCheck.length === 0) {
        logger.debug('No pending quotes to check')
        return
      }

      logger.info(
        { count: quotesToCheck.length },
        'Checking pending quotes for deposits'
      )

      let confirmedCount = 0

      // Check each quote for deposits
      for (const quote of quotesToCheck) {
        try {
          const depositStatus = await this.runesBackend.checkDeposit(
            quote.id,
            quote.request
          )

          if (depositStatus.confirmed) {
            // Update quote to PAID
            await this.quoteRepo.updateMintQuoteState(quote.id, 'PAID')
            confirmedCount++

            logger.info(
              {
                quoteId: quote.id,
                amount: quote.amount,
                txid: depositStatus.txid,
                confirmations: depositStatus.confirmations,
              },
              'Deposit confirmed - quote marked as PAID'
            )
          }
        } catch (error) {
          // Log error but continue checking other quotes
          logger.warn(
            { error, quoteId: quote.id },
            'Error checking deposit for quote'
          )
        }
      }

      const duration = Date.now() - startTime

      logger.info(
        {
          checked: quotesToCheck.length,
          confirmed: confirmedCount,
          duration,
        },
        'Deposit check cycle completed'
      )
    } catch (error) {
      logger.error({ error }, 'Error in checkPendingDeposits')
      throw error
    }
  }

  /**
   * Get the current status of the monitor
   */
  getStatus(): {
    isRunning: boolean
    config: DepositMonitorConfig
  } {
    return {
      isRunning: this.isRunning,
      config: this.config,
    }
  }
}

/**
 * Helper method to find quotes by state
 * This should be added to QuoteRepository
 */
declare module '../database/repositories/QuoteRepository.js' {
  interface QuoteRepository {
    findMintQuotesByState(state: string, limit?: number): Promise<
      Array<{
        id: string
        amount: number
        unit: string
        rune_id: string
        request: string
        state: string
        expiry: number
        created_at: number
      }>
    >
  }
}
