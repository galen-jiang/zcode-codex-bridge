// Tests for the coordinator state-dir resolution contract:
// explicit config.stateDir > CODEX_BRIDGE_STATE_DIR > homedir default.
// Every source must be an absolute normalized zcode-runs directory; invalid
// explicit values are rejected. Runs the real CLI entry with subprocess
// isolation (own HOME) against synthetic ledgers in temporary directories —
// never the real default state directory.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const entry = process.env.COORDINATOR_CANDIDATE
assert.ok(entry, 'COORDINATOR_CANDIDATE must point at the candidate coordinator entry')

// Status-probe fixture: a ledger whose status marker tells us WHICH state
// directory the entry actually read, regardless of downstream behavior.
function makeProbe(dir, statusMark) {
  fs.mkdirSync(dir, { recursive: true })
  const run = randomUUID()
  const ledgerPath = join(dir, `${run}.json`)
  fs.writeFileSync(ledgerPath, JSON.stringify({
    run_id: run,
    revision: 0,
    status: statusMark,
    coordinator: { task_id: '01020304-0506-7708-9000-000000000000' },
    outstanding_dispatch_id: null,
    handled_dispatch_ids: [],
    attempt: null,
  }))
  return { run, ledgerPath }
}

function probe({ home, envDir, configDir, homeStatus, envStatus, configStatus }) {
  const cfg = {
    runId: null,
    dispatchId: randomUUID(),
    coordinatorTaskId: '01020304-0506-7708-9000-000000000000',
    expectedRevision: 0,
    stopAt: '2099-01-01T00:00:00Z',
    zcodeProject: 'demo-project',
    zcodeTaskTitle: 'demo title',
    briefPath: 'demo-brief.md',
    milestone: 'demo',
    zcodeModel: 'demo-model',
  }
  let effective = join(home, '.codex', 'state', 'zcode-runs')
  let mark = homeStatus
  if (envDir !== undefined) { effective = envDir; mark = envStatus }
  if (configDir !== undefined) { effective = configDir; mark = configStatus; cfg.stateDir = configDir }
  if (mark !== undefined) cfg.runId = makeProbe(effective, mark).run
  const result = spawnSync(process.execPath, [entry, 'dispatching', JSON.stringify(cfg)], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: home, CODEX_BRIDGE_STATE_DIR: envDir },
  })
  return result
}

test('default resolution with isolated HOME reads $HOME/.codex/state/zcode-runs', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'state-dir-home-'))
  makeProbe(join(home, '.codex', 'state', 'zcode-runs'), 'bogus-home')
  const result = probe({ home, homeStatus: 'bogus-home' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /status mismatch: bogus-home/,
    'the entry must read the ledger from the HOME-derived state directory')
})

test('CODEX_BRIDGE_STATE_DIR overrides the homedir default without config.stateDir', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'state-dir-home-'))
  fs.mkdirSync(join(home, '.codex', 'state', 'zcode-runs'), { recursive: true })
  const envDir = join(fs.mkdtempSync(join(tmpdir(), 'state-dir-env-')), 'zcode-runs')
  const result = probe({ home, envDir, envStatus: 'bogus-env' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /status mismatch: bogus-env/,
    'the entry must read the ledger from the env-overridden state directory')
})

test('explicit config.stateDir wins over CODEX_BRIDGE_STATE_DIR', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'state-dir-home-'))
  const envDir = join(fs.mkdtempSync(join(tmpdir(), 'state-dir-env-')), 'zcode-runs')
  const configDir = join(fs.mkdtempSync(join(tmpdir(), 'state-dir-cfg-')), 'zcode-runs')
  const result = probe({ home, envDir, configDir, homeStatus: 'bogus-home', envStatus: 'bogus-env', configStatus: 'bogus-cfg' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /status mismatch: bogus-cfg/,
    'the entry must read the ledger from the config-specified state directory')
})

test('invalid explicit config.stateDir is rejected, not silently falling back', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'state-dir-home-'))
  const result = spawnSync(process.execPath, [entry, 'dispatching', JSON.stringify({
    runId: randomUUID(),
    dispatchId: randomUUID(),
    coordinatorTaskId: '01020304-0506-7708-9000-000000000000',
    expectedRevision: 1,
    stopAt: '2099-01-01T00:00:00Z',
    zcodeProject: 'demo-project',
    zcodeTaskTitle: 'demo title',
    briefPath: 'demo-brief.md',
    milestone: 'demo',
    zcodeModel: 'demo-model',
    stateDir: 'relative/not-normalized',
  })], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: fs.mkdtempSync(join(tmpdir(), 'state-dir-home-')) },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /stateDir must be an absolute normalized zcode-runs directory/)
})

test('invalid CODEX_BRIDGE_STATE_DIR is rejected, not silently ignored', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'state-dir-home-'))
  const result = spawnSync(process.execPath, [entry, 'dispatching', JSON.stringify({
    runId: randomUUID(),
    dispatchId: randomUUID(),
    coordinatorTaskId: '01020304-0506-7708-9000-000000000000',
    expectedRevision: 1,
    stopAt: '2099-01-01T00:00:00Z',
    zcodeProject: 'demo-project',
    zcodeTaskTitle: 'demo title',
    briefPath: 'demo-brief.md',
    milestone: 'demo',
    zcodeModel: 'demo-model',
  })], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: fs.mkdtempSync(join(tmpdir(), 'state-dir-home-')), CODEX_BRIDGE_STATE_DIR: 'relative/not-normalized' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /stateDir must be an absolute normalized zcode-runs directory/)
})

test('explicit null stateDir is invalid even when the environment is valid', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'state-dir-null-'))
  const envDir = join(home, 'zcode-runs')
  const result = spawnSync(process.execPath, [entry, 'dispatching', JSON.stringify({
    stateDir: null,
  })], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: home, CODEX_BRIDGE_STATE_DIR: envDir },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /stateDir must be an absolute normalized zcode-runs directory/)
  assert.deepEqual(fs.readdirSync(home), [], 'invalid configuration must not create state')
})
