import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const script = new URL('../scripts/receipt.mjs', import.meta.url)
const runId = '11111111-1111-4111-8111-111111111111'
const dispatchId = '22222222-2222-4222-8222-222222222222'
const coordinatorTaskId = '01TESTTASK'
const futureStopAt = '2099-01-01T00:00:00+00:00'

function fixture(t, options = {}) {
  const stopAt = options.stopAt ?? futureStopAt
  const root = mkdtempSync(join(tmpdir(), 'zcode-callback-bridge-'))
  const stateDir = join(root, 'zcode-runs')
  mkdirSync(stateDir)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const ledger = join(stateDir, `${runId}.json`)
  const tombstone = join(stateDir, `${runId}.tombstone`)
  const receiver = join(stateDir, `${runId}.${dispatchId}.receiver`)
  writeFileSync(ledger, `${JSON.stringify({
    run_id: runId,
    coordinator: { task_id: coordinatorTaskId },
    status: 'dispatched',
    outstanding_dispatch_id: dispatchId,
    attempt: { dispatch_id: dispatchId, receiver_receipt_path: receiver },
    attempt_limits: { stop_at: stopAt },
  })}\n`)

  return { root, stateDir, ledger, tombstone, receiver, stopAt }
}

function invocationArgs(command, paths, extra = []) {
  return [
    script.pathname,
    command,
    '--ledger', paths.ledger,
    '--tombstone', paths.tombstone,
    '--receiver', paths.receiver,
    '--run-id', runId,
    '--dispatch-id', dispatchId,
    '--coordinator-task-id', coordinatorTaskId,
    '--stop-at', paths.stopAt,
    ...extra,
  ]
}

function invoke(command, paths, extra = []) {
  return spawnSync(process.execPath, invocationArgs(command, paths, extra), { encoding: 'utf8' })
}

function invokeAsync(command, paths, extra = []) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, invocationArgs(command, paths, extra))
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('close', status => resolveResult({ status, stdout, stderr }))
  })
}

function claim(paths) {
  const result = invoke('claim', paths)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('claim creates one durable active receipt and rejects a duplicate claim', (t) => {
  const paths = fixture(t)
  const originalLedger = readFileSync(paths.ledger, 'utf8')
  const claimed = claim(paths)
  const firstReceipt = readFileSync(join(paths.receiver, 'receipt.json'), 'utf8')
  const receipt = JSON.parse(firstReceipt)

  assert.match(claimed.receiver_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(receipt, {
    protocol: 'zcode-callback-receipt/v1',
    run_id: runId,
    dispatch_id: dispatchId,
    coordinator_task_id: coordinatorTaskId,
    stop_at: futureStopAt,
    receiver_id: claimed.receiver_id,
    status: 'active',
    created_at: receipt.created_at,
  })
  assert.equal(statSync(paths.receiver).mode & 0o777, 0o700)
  assert.equal(statSync(join(paths.receiver, 'receipt.json')).mode & 0o777, 0o600)
  assert.equal(readFileSync(paths.ledger, 'utf8'), originalLedger)

  const duplicate = invoke('claim', paths)
  assert.notEqual(duplicate.status, 0)
  assert.equal(readFileSync(join(paths.receiver, 'receipt.json'), 'utf8'), firstReceipt)
})

test('claim rejects a non-dispatched ledger without creating a receiver', (t) => {
  const paths = fixture(t)
  writeFileSync(paths.ledger, `${JSON.stringify({
    run_id: runId,
    status: 'ready',
    outstanding_dispatch_id: dispatchId,
    attempt: { dispatch_id: dispatchId },
  })}\n`)

  const result = invoke('claim', paths)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('ledger is not the outstanding dispatched attempt'), true)
  assert.equal(result.stdout, '')
  assert.equal(existsSync(paths.receiver), false)
})

test('claim rejects a tombstoned run without creating a receiver', (t) => {
  const paths = fixture(t)
  writeFileSync(paths.tombstone, '{}\n')

  const result = invoke('claim', paths)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('tombstone exists'), true)
  assert.equal(existsSync(paths.receiver), false)
})

test('claim rejects an expired dispatch deadline', (t) => {
  const paths = fixture(t, { stopAt: '2020-01-01T00:00:00+00:00' })

  const result = invoke('claim', paths)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('dispatch stop_at has passed'), true)
  assert.equal(existsSync(paths.receiver), false)
})

test('claim rejects a coordinator target that does not match the ledger', (t) => {
  const paths = fixture(t)
  const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'))
  ledger.coordinator.task_id = '01OTHER'
  writeFileSync(paths.ledger, `${JSON.stringify(ledger)}\n`)

  const result = invoke('claim', paths)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('ledger coordinator or stop_at does not match the envelope'), true)
  assert.equal(existsSync(paths.receiver), false)
})

test('claim rejects a receiver path that does not match the ledger attempt', (t) => {
  const paths = fixture(t)
  const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'))
  ledger.attempt.receiver_receipt_path = `${paths.receiver}.other`
  writeFileSync(paths.ledger, `${JSON.stringify(ledger)}\n`)

  const result = invoke('claim', paths)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('ledger receiver path does not match the envelope'), true)
  assert.equal(existsSync(paths.receiver), false)
})

test('claim rejects paths outside the canonical run naming scheme', (t) => {
  const paths = fixture(t)
  const outside = { ...paths, receiver: join(paths.root, 'receiver') }

  const result = invoke('claim', outside)
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('receiver path does not match run and dispatch IDs'), true)
})

test('assert-active detects a cancellation fence after a successful claim', (t) => {
  const paths = fixture(t)
  const claimed = claim(paths)
  const active = invoke('assert-active', paths, ['--receiver-id', claimed.receiver_id])
  assert.equal(active.status, 0, active.stderr)

  writeFileSync(paths.tombstone, '{}\n')
  const fenced = invoke('assert-active', paths, ['--receiver-id', claimed.receiver_id])
  assert.notEqual(fenced.status, 0)
  assert.equal(fenced.stderr.includes('tombstone exists'), true)
})

test('release atomically records the terminal outcome and cannot be repeated', (t) => {
  const paths = fixture(t)
  const claimed = claim(paths)
  const released = invoke('release', paths, [
    '--receiver-id', claimed.receiver_id,
    '--outcome', 'blocked',
    '--reason', 'focused verification failed',
  ])
  assert.equal(released.status, 0, released.stderr)

  const receipt = JSON.parse(readFileSync(join(paths.receiver, 'receipt.json'), 'utf8'))
  assert.equal(receipt.status, 'released')
  assert.equal(receipt.outcome, 'blocked')
  assert.equal(receipt.reason, 'focused verification failed')
  assert.match(receipt.released_at, /^\d{4}-\d\d-\d\dT/)

  const repeated = invoke('release', paths, [
    '--receiver-id', claimed.receiver_id,
    '--outcome', 'completed',
  ])
  assert.notEqual(repeated.status, 0)
  assert.equal(JSON.parse(readFileSync(join(paths.receiver, 'receipt.json'), 'utf8')).outcome, 'blocked')
})

test('release rejects the wrong receiver identity', (t) => {
  const paths = fixture(t)
  claim(paths)

  const result = invoke('release', paths, [
    '--receiver-id', '33333333-3333-4333-8333-333333333333',
    '--outcome', 'completed',
  ])
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('active receipt identity mismatch'), true)
  assert.equal(JSON.parse(readFileSync(join(paths.receiver, 'receipt.json'), 'utf8')).status, 'active')
})

test('release remains available after a cancellation fence so the writer can become silent', (t) => {
  const paths = fixture(t)
  const claimed = claim(paths)
  writeFileSync(paths.tombstone, '{}\n')

  const result = invoke('release', paths, [
    '--receiver-id', claimed.receiver_id,
    '--outcome', 'blocked',
    '--reason', 'cancellation fence observed',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(join(paths.receiver, 'receipt.json'), 'utf8')).status, 'released')
})

test('release fails closed while another terminal transition owns the lock', (t) => {
  const paths = fixture(t)
  const claimed = claim(paths)
  mkdirSync(join(paths.receiver, '.transition.lock'))

  const result = invoke('release', paths, [
    '--receiver-id', claimed.receiver_id,
    '--outcome', 'completed',
  ])
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('receipt transition is already in progress'), true)
  assert.equal(JSON.parse(readFileSync(join(paths.receiver, 'receipt.json'), 'utf8')).status, 'active')
})

test('two concurrent terminal releases produce exactly one immutable outcome', async (t) => {
  const paths = fixture(t)
  const claimed = claim(paths)
  const common = ['--receiver-id', claimed.receiver_id]

  const attempts = await Promise.all([
    invokeAsync('release', paths, [...common, '--outcome', 'completed']),
    invokeAsync('release', paths, [...common, '--outcome', 'blocked']),
  ])
  const successes = attempts.filter(result => result.status === 0)
  assert.equal(successes.length, 1)

  const receipt = JSON.parse(readFileSync(join(paths.receiver, 'receipt.json'), 'utf8'))
  assert.equal(receipt.status, 'released')
  assert.equal(receipt.outcome, JSON.parse(successes[0].stdout).outcome)
})
