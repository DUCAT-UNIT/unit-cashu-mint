import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pool, query } from '../src/database/db.js'
import { logger } from '../src/utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface Migration {
  id: number
  name: string
  path: string
}

const migrations: Migration[] = [
  { id: 1, name: '001_initial', path: '../src/database/migrations/001_initial.sql' },
]

async function createMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

async function getAppliedMigrations(): Promise<number[]> {
  const result = await query<{ id: number }>('SELECT id FROM migrations ORDER BY id')
  return result.rows.map((row) => row.id)
}

async function runMigration(migration: Migration) {
  const migrationPath = join(__dirname, migration.path)
  const sql = readFileSync(migrationPath, 'utf-8')

  // Split by statement and filter out migration tracking (we'll handle that)
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !s.includes('migrations') || s.includes('CREATE TABLE'))

  logger.info({ migration: migration.name }, 'Applying migration')

  for (const statement of statements) {
    try {
      await query(statement)
    } catch (err) {
      logger.error({ err, statement }, 'Migration statement failed')
      throw err
    }
  }

  // Record migration
  await query('INSERT INTO migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
    migration.id,
    migration.name,
  ])

  logger.info({ migration: migration.name }, 'Migration applied successfully')
}

async function migrate() {
  try {
    logger.info('Starting database migration')

    // Create migrations table if it doesn't exist
    await createMigrationsTable()

    // Get applied migrations
    const appliedMigrations = await getAppliedMigrations()
    logger.info({ appliedMigrations }, 'Found applied migrations')

    // Run pending migrations
    for (const migration of migrations) {
      if (!appliedMigrations.includes(migration.id)) {
        await runMigration(migration)
      } else {
        logger.info({ migration: migration.name }, 'Migration already applied, skipping')
      }
    }

    logger.info('Database migration completed successfully')
  } catch (err) {
    logger.error({ err }, 'Migration failed')
    throw err
  } finally {
    await pool.end()
  }
}

// Run migrations
migrate().catch((err) => {
  console.error('Migration error:', err)
  process.exit(1)
})
