import { getPool } from '../database/db.js'
import { KeysetRepository } from '../database/repositories/KeysetRepository.js'
import { QuoteRepository } from '../database/repositories/QuoteRepository.js'
import { ProofRepository } from '../database/repositories/ProofRepository.js'
import { KeyManager } from '../core/crypto/KeyManager.js'
import { MintCrypto } from '../core/crypto/MintCrypto.js'
import { MintService } from '../core/services/MintService.js'
import { SwapService } from '../core/services/SwapService.js'
import { MeltService } from '../core/services/MeltService.js'
import { RunesBackend } from '../runes/RunesBackend.js'
import { BackgroundTaskManager } from '../services/BackgroundTaskManager.js'

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

  // Runes Backend
  const db = getPool()
  const runesBackend = new RunesBackend(db)

  container.register('runesBackend', runesBackend)

  // Services
  const mintService = new MintService(mintCrypto, quoteRepo, runesBackend)
  const swapService = new SwapService(mintCrypto, proofRepo)
  const meltService = new MeltService(mintCrypto, quoteRepo, proofRepo, runesBackend)

  container.register('mintService', mintService)
  container.register('swapService', swapService)
  container.register('meltService', meltService)

  // Background tasks
  const backgroundTasks = new BackgroundTaskManager(runesBackend, quoteRepo)
  container.register('backgroundTasks', backgroundTasks)

  return container
}
