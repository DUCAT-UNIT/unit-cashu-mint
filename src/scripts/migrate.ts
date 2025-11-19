#!/usr/bin/env node
/**
 * Database migration script
 * Runs SQL migration files in order
 */

import { readdir, readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pool } from '../database/db.js'
import { logger } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Migrations directory
const MIGRATIONS_DIR = join(__dirname, '../../migrations')

async function runMigrations() {
  try {
    logger.info('Starting database migrations...')

    // Create migrations tracking table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        migration_name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Get list of migration files
    const files = await readdir(MIGRATIONS_DIR)
    const sqlFiles = files
      .filter((f) => f.endsWith('.sql'))
      .sort() // Sort alphabetically (assumes format: 001_name.sql, 002_name.sql, etc.)

    logger.info({ count: sqlFiles.length }, 'Found migration files')

    // Check which migrations have already been applied
    const appliedResult = await pool.query<{ migration_name: string }>(
      'SELECT migration_name FROM schema_migrations'
    )
    const appliedMigrations = new Set(appliedResult.rows.map((r) => r.migration_name))

    // Run each migration
    for (const file of sqlFiles) {
      if (appliedMigrations.has(file)) {
        logger.info({ migration: file }, 'Migration already applied, skipping')
        continue
      }

      logger.info({ migration: file }, 'Applying migration')

      const filePath = join(MIGRATIONS_DIR, file)
      const sql = await readFile(filePath, 'utf-8')

      // Run migration in a transaction
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query(
          'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
          [file]
        )
        await client.query('COMMIT')
        logger.info({ migration: file }, 'Migration applied successfully')
      } catch (error) {
        await client.query('ROLLBACK')
        logger.error({ error, migration: file }, 'Migration failed, rolling back')
        throw error
      } finally {
        client.release()
      }
    }

    logger.info('All migrations completed successfully!')
  } catch (error) {
    logger.error({ error }, 'Migration process failed')
    throw error
  } finally {
    await pool.end()
  }
}

// Run migrations
runMigrations().catch((error) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
