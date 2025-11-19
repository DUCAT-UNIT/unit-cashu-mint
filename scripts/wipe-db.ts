import { query, closePool } from '../src/database/db.js'
import { logger } from '../src/utils/logger.js'

async function wipeDatabase() {
  try {
    logger.info('Starting database wipe...')

    // Delete in order to respect foreign key constraints
    await query('DELETE FROM proofs')
    logger.info('Deleted all proofs')

    await query('DELETE FROM mint_quotes')
    logger.info('Deleted all mint quotes')

    await query('DELETE FROM melt_quotes')
    logger.info('Deleted all melt quotes')

    await query('DELETE FROM keysets')
    logger.info('Deleted all keysets')

    await query('DELETE FROM mint_utxos')
    logger.info('Deleted all UTXOs')

    logger.info('✅ Database wiped successfully!')
    await closePool()
    process.exit(0)
  } catch (error) {
    logger.error({ error }, 'Failed to wipe database')
    process.exit(1)
  }
}

wipeDatabase()
