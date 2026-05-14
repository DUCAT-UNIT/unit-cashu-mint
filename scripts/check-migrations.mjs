#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const migrationsDir = resolve(repoRoot, 'migrations')
const duplicateMigrationsDir = resolve(repoRoot, 'src/database/migrations')
const errors = []

if (!existsSync(migrationsDir)) {
  errors.push('Missing canonical migrations/ directory.')
} else {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    errors.push('migrations/ must contain at least one SQL migration.')
  }

  const seenIds = new Set()
  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(file)
    if (!match) {
      errors.push(`${file} must match ###_snake_case.sql.`)
      continue
    }

    const id = Number(match[1])
    const expectedId = index + 1
    if (id !== expectedId) {
      errors.push(`${file} has migration id ${id}; expected ${expectedId}.`)
    }
    if (seenIds.has(id)) {
      errors.push(`${file} reuses migration id ${id}.`)
    }
    seenIds.add(id)

    const sql = await readFile(resolve(migrationsDir, file), 'utf8')
    if (!/INSERT\s+INTO\s+migrations\b/i.test(sql)) {
      errors.push(`${file} must update the legacy migrations table for upgrade compatibility.`)
    }
  }
}

if (existsSync(duplicateMigrationsDir)) {
  const duplicateSqlFiles = (await readdir(duplicateMigrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort()
  if (duplicateSqlFiles.length > 0) {
    errors.push(
      `src/database/migrations contains duplicate SQL files: ${duplicateSqlFiles.join(', ')}. ` +
        'Use root migrations/ only.'
    )
  }
}

if (errors.length > 0) {
  console.error('Migration checks failed:')
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exit(1)
}

console.log('Migration checks passed.')
