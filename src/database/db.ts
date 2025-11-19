import pg from 'pg'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

const { Pool } = pg

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

// Test connection on startup
pool.on('connect', () => {
  logger.debug('New database connection established')
})

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database error')
})

// Helper for running queries
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) {
  const start = Date.now()
  try {
    const result = await pool.query<T>(text, params)
    const duration = Date.now() - start
    logger.debug({ text, duration, rows: result.rowCount }, 'Executed query')
    return result
  } catch (err) {
    logger.error({ err, text }, 'Database query error')
    throw err
  }
}

// Helper for transactions
export async function transaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// Test connection
export async function testConnection(): Promise<boolean> {
  try {
    const result = await query<{ now: Date }>('SELECT NOW() as now')
    logger.info({ time: result.rows[0]?.now }, 'Database connection successful')
    return true
  } catch (err) {
    logger.error({ err }, 'Database connection failed')
    return false
  }
}

// Get pool instance
export function getPool(): pg.Pool {
  return pool
}

// Close pool
export async function closePool(): Promise<void> {
  await pool.end()
  logger.info('Database pool closed')
}
