// Tests for scripts/privacy-scan.mjs using fully synthetic fixtures only.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scanner = new URL('../scripts/privacy-scan.mjs', import.meta.url).pathname

test('detects planted absolute paths and emails, exits 1 with hits', () => {
  const tree = fs.mkdtempSync(join(tmpdir(), 'privacy-scan-test-'))
  const plantedPath = '/Users/' + 'somebody/secret'
  const plantedEmail = 'me@' + 'example.com'
  fs.writeFileSync(join(tree, 'sample.md'), `see ${plantedPath} and ${plantedEmail}\n`)
  const result = spawnSync(process.execPath, [scanner, tree], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /HIT absolute-user-path/)
  assert.match(result.stdout, /HIT email/)
  assert.match(result.stdout, /PRIVACY_SCAN_HITS=2/)
})

test('scans the complete package source including scanner and test fixtures', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const result = spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /PRIVACY_SCAN_CLEAN/)
})

test('passes on a clean synthetic tree, exits 0', () => {
  const tree = fs.mkdtempSync(join(tmpdir(), 'privacy-scan-test-'))
  fs.writeFileSync(join(tree, 'clean.md'), 'install to <skills-install-root>/codex-callback-bridge\n')
  const result = spawnSync(process.execPath, [scanner, tree], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /PRIVACY_SCAN_CLEAN/)
})
