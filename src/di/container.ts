import { getPool } from '../database/db.js'
import { KeysetRepository } from '../database/repositories/KeysetRepository.js'
import { QuoteRepository } from '../database/repositories/QuoteRepository.js'
import { ProofRepository } from '../database/repositories/ProofRepository.js'
import { KeyManager } from '../core/crypto/KeyManager.js'
import { MintCrypto } from '../core/crypto/MintCrypto.js'
import { MintService } from '../core/services/MintService.js'
import { SwapService } from '../core/services/SwapService.js'
import { MeltService } from '../core/services/MeltService.js'
import { CheckStateService } from '../core/services/CheckStateService.js'
import { RunesBackend } from '../runes/RunesBackend.js'
import { BTCBackend } from '../btc/BTCBackend.js'
import { BackendRegistry } from '../core/payment/BackendRegistry.js'
import { BackgroundTaskManager } from '../services/BackgroundTaskManager.js'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

/**
 * Simple dependency injection container
 */
export class DIContainer {
  private services = new Map<string, unknown>()

  register<T>(name: string, instance: T): void {
    this.services.set(name, instance)
  }

  resolve<T>(name: string): T {
    const service = this.services.get(name)
    if (!service) {
      throw new Error(`Service ${name} not found in DI container`)
    }
    return service as T
  }

  has(name: string): boolean {
    return this.services.has(name)
  }
}

/**
 * Initialize all services and register them in the container
 */
export function initializeContainer(): DIContainer {
  const container = new DIContainer()

  // Repositories
  const keysetRepo = new KeysetRepository()
  const quoteRepo = new QuoteRepository()
  const proofRepo = new ProofRepository()

  container.register('keysetRepository', keysetRepo)
  container.register('quoteRepository', quoteRepo)
  container.register('proofRepository', proofRepo)

  // Crypto
  const keyManager = new KeyManager(keysetRepo)
  const mintCrypto = new MintCrypto(keyManager)

  container.register('keyManager', keyManager)
  container.register('mintCrypto', mintCrypto)

  // Database pool
  const db = getPool()

  // Backend Registry - supports multiple payment backends
  const backendRegistry = new BackendRegistry()

  // Register Runes backend if 'unit' is enabled
  if (env.SUPPORTED_UNITS_ARRAY.includes('unit')) {
    const runesBackend = new RunesBackend(db)
    backendRegistry.register(runesBackend)
    container.register('runesBackend', runesBackend)
    logger.info({ unit: 'unit' }, 'Registered Runes backend')
  }

  // Register BTC backend if 'btc' unit is enabled
  if (env.SUPPORTED_UNITS_ARRAY.includes('btc')) {
    const btcBackend = new BTCBackend({
      mintAddress: env.MINT_BTC_ADDRESS!,
      mintPubkey: env.MINT_BTC_PUBKEY || '',
      feeRate: env.BTC_FEE_RATE,
      network: env.NETWORK,
      minConfirmations: env.MINT_CONFIRMATIONS,
    })
    backendRegistry.register(btcBackend)
    container.register('btcBackend', btcBackend)
    logger.info({ unit: 'btc' }, 'Registered BTC backend')
  }

  container.register('backendRegistry', backendRegistry)

  // Services - now using backend registry
  const mintService = new MintService(mintCrypto, quoteRepo, backendRegistry, keyManager)
  const swapService = new SwapService(mintCrypto, proofRepo)
  const meltService = new MeltService(mintCrypto, quoteRepo, proofRepo, backendRegistry)
  const checkStateService = new CheckStateService(mintCrypto, proofRepo)

  container.register('mintService', mintService)
  container.register('swapService', swapService)
  container.register('meltService', meltService)
  container.register('checkStateService', checkStateService)

  // Background tasks
  const backgroundTasks = new BackgroundTaskManager(backendRegistry, quoteRepo)
  container.register('backgroundTasks', backgroundTasks)

  return container
}
