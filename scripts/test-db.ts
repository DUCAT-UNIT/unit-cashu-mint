import { testConnection, closePool } from '../src/database/db.js'
import { KeysetRepository, QuoteRepository, ProofRepository } from '../src/database/repositories/index.js'
import { logger } from '../src/utils/logger.js'

async function testDatabase() {
  try {
    logger.info('Testing database connection...')

    // Test connection
    const connected = await testConnection()
    if (!connected) {
      throw new Error('Failed to connect to database')
    }

    // Test repositories
    const keysetRepo = new KeysetRepository()
    const quoteRepo = new QuoteRepository()
    const proofRepo = new ProofRepository()

    // Test keyset queries
    logger.info('Testing KeysetRepository...')
    const keysets = await keysetRepo.findAll()
    logger.info({ count: keysets.length }, 'Found keysets')

    // Test quote queries
    logger.info('Testing QuoteRepository...')
    const expiredMintQuotes = await quoteRepo.findExpiredMintQuotes()
    logger.info({ count: expiredMintQuotes.length }, 'Found expired mint quotes')

    // Test proof queries
    logger.info('Testing ProofRepository...')
    const spentCount = await proofRepo.getSpentCount()
    logger.info({ count: spentCount }, 'Found spent proofs')

    logger.info('✅ All database tests passed!')
  } catch (err) {
    logger.error({ err }, '❌ Database tests failed')
    throw err
  } finally {
    await closePool()
  }
}

testDatabase().catch((err) => {
  console.error('Test error:', err)
  process.exit(1)
})
