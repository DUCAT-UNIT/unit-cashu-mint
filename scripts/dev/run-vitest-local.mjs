#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const vitestEntry = join(repoRoot, 'node_modules/vitest/vitest.mjs')
const args = process.argv.slice(2)

if (!existsSync(vitestEntry)) {
  throw new Error('Vitest is not installed. Run npm ci first.')
}

const selectedNode = selectNode()
if (selectedNode !== process.execPath) {
  console.error(
    `Using ${selectedNode} for Vitest because the current Node.js runtime cannot load Vitest native bindings.`
  )
}

const result = spawnSync(selectedNode, [vitestEntry, ...args], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
})

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)

function selectNode() {
  const candidates = candidateNodes()
  const working = []
  const failures = []

  for (const candidate of candidates) {
    const check = spawnSync(candidate, [vitestEntry, 'list', '--config', 'vitest.config.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    })
    if (check.status === 0) {
      working.push(candidate)
      continue
    }

    failures.push(`${candidate}: ${(check.stderr || check.stdout || '').split('\n')[0]}`)
  }

  const supported = working.find((candidate) => nodeMajor(candidate) >= 22)
  if (supported) {
    return supported
  }
  if (working[0]) {
    console.error(`No Vitest-compatible Node.js >=22 was found; falling back to ${working[0]}.`)
    return working[0]
  }

  throw new Error(`No Node.js runtime could load Vitest native bindings.\n${failures.join('\n')}`)
}

function candidateNodes() {
  return unique(
    [
      process.env.TEST_NODE,
      process.execPath,
      process.env.VOLTA_HOME ? join(process.env.VOLTA_HOME, 'bin/node') : null,
      process.env.NVM_BIN ? join(process.env.NVM_BIN, 'node') : null,
      process.env.FNM_MULTISHELL ? join(process.env.FNM_MULTISHELL, 'bin/node') : null,
      join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'),
      ...pathNodes(),
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
    ].filter(Boolean)
  ).filter((candidate) => existsSync(candidate))
}

function pathNodes() {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => join(entry, 'node'))
}

function unique(values) {
  return [...new Set(values)]
}

function nodeMajor(candidate) {
  const result = spawnSync(candidate, ['-p', "process.versions.node.split('.')[0]"], {
    encoding: 'utf8',
  })
  return result.status === 0 ? Number(result.stdout.trim()) : 0
}
