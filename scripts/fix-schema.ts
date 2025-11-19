import { query, closePool } from '../src/database/db.js'
import { logger } from '../src/utils/logger.js'

async function fixSchema() {
  try {
    logger.info('Checking mint_utxos schema...')

    // Check if value column exists
    const checkColumn = await query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'mint_utxos'
      ORDER BY ordinal_position
    `)

    logger.info('Current columns:', checkColumn.rows)

    const hasValueColumn = checkColumn.rows.some(
      (row) => row.column_name === 'value'
    )

    if (!hasValueColumn) {
      logger.info('Adding missing value column...')
      await query(`
        ALTER TABLE mint_utxos
        ADD COLUMN value INTEGER NOT NULL DEFAULT 0
      `)
      logger.info('✅ Added value column')
    } else {
      logger.info('✅ Schema is correct - value column exists')
    }

    // Also check amount column type
    const amountCol = checkColumn.rows.find((row) => row.column_name === 'amount')
    if (amountCol?.data_type === 'bigint') {
      logger.info('Converting amount column from BIGINT to TEXT for compatibility...')
      await query(`
        ALTER TABLE mint_utxos
        ALTER COLUMN amount TYPE TEXT USING amount::TEXT
      `)
      logger.info('✅ Converted amount column to TEXT')
    }

    await closePool()
    process.exit(0)
  } catch (error) {
    logger.error({ error }, 'Failed to fix schema')
    await closePool()
    process.exit(1)
  }
}

fixSchema()
