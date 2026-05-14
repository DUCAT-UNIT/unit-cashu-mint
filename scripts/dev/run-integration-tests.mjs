#!/usr/bin/env node
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const defaultDatabaseUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/mint_dev'
const databaseUrl = process.env.DATABASE_URL || defaultDatabaseUrl
const testEnv = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
}

const vitestArgs = process.argv.slice(2)
const runMigrations = process.env.INTEGRATION_RUN_MIGRATIONS !== 'false'

let databaseStarted = false
if (!(await waitForDatabase(databaseUrl, { attempts: 1 }))) {
  databaseStarted = await maybeStartPostgres()
}

const databaseWaitAttempts = databaseStarted ? 30 : 2
if (!(await waitForDatabase(databaseUrl, { attempts: databaseWaitAttempts }))) {
  console.error(`Integration database is not reachable at ${redactDatabaseUrl(databaseUrl)}.`)
  console.error('Start Postgres with `docker-compose up -d postgres`, or set DATABASE_URL to a reachable test database.')
  process.exit(1)
}

if (runMigrations) {
  runStepOrExit(npmCommand(), ['run', 'migrate'], testEnv)
}

exitWith(
  process.execPath,
  ['scripts/dev/run-vitest-local.mjs', '--run', '--config', 'vitest.integration.config.ts', ...vitestArgs],
  testEnv
)

async function maybeStartPostgres() {
  if (process.env.INTEGRATION_AUTO_START_POSTGRES === 'false') {
    return false
  }

  const compose = findDockerCompose()
  if (!compose) {
    return false
  }

  console.error('Integration database is not reachable; starting docker-compose postgres service.')
  const result = spawnSync(compose.command, [...compose.args, 'up', '-d', 'postgres'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) {
    console.error(`Failed to start docker-compose postgres service: ${result.error.message}`)
  }
  return result.status === 0
}

async function waitForDatabase(connectionString, { attempts }) {
  const { Pool } = pg

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 1000,
    })

    try {
      await pool.query('SELECT 1')
      await pool.end()
      return true
    } catch {
      await pool.end().catch(() => undefined)
      if (attempt < attempts) {
        await sleep(1000)
      }
    }
  }

  return false
}

function findDockerCompose() {
  if (commandSucceeds('docker', ['compose', 'version'])) {
    return { command: 'docker', args: ['compose'] }
  }

  if (commandSucceeds('docker-compose', ['--version'])) {
    return { command: 'docker-compose', args: [] }
  }

  return null
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'ignore',
  })
  return result.status === 0
}

function runStepOrExit(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function exitWith(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }
  process.exit(result.status ?? 1)
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function redactDatabaseUrl(value) {
  try {
    const url = new URL(value)
    if (url.password) {
      url.password = '****'
    }
    return url.toString()
  } catch {
    return '<invalid DATABASE_URL>'
  }
}
