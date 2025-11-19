import { beforeAll, afterAll } from 'vitest'
import { pool, testConnection } from '../src/database/db.js'
import { logger } from '../src/utils/logger.js'

beforeAll(async () => {
  logger.info('🧪 Test suite starting...')

  // Test database connection
  const connected = await testConnection()
  if (!connected) {
    throw new Error('Failed to connect to test database')
  }

  logger.info('✅ Test database connected')
})

afterAll(async () => {
  // Clean up database connection
  await pool.end()
  logger.info('🧹 Test cleanup complete')
})
