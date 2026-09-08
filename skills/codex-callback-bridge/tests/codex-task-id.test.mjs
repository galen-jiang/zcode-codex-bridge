// CodexTaskIdV7Repair: Codex issues coordinator task IDs as UUIDv7; the
// candidate reconcile entry must accept them without loosening run/dispatch/
// receiver identity validation. Drives the flow through the real coordinator
// entry CLI (reconcile-receipt / review-holder), not only the helper.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const candidate = process.env.CANDIDATE_BRIDGE
const coordinatorEntry = process.env.COORDINATOR_CANDIDATE
assert.ok(candidate, 'CANDIDATE_BRIDGE must point at the candidate bridge directory')
assert.ok(coordinatorEntry, 'COORDINATOR_CANDIDATE must point at the coordinator entry')

const SYNTHETIC_CODEX_V7 = '01020304-0506-7708-9000-000000000000'
const STOP_AT = '2099-01-01T00:00:00Z'

function fixture(coordinatorTaskId) {
  const temp = fs.mkdtempSync(join(tmpdir(), 'codex-task-id-'))
  const state = join(temp, 'zcode-runs')
  fs.mkdirSync(state)
  const run = randomUUID()
  const dispatch = randomUUID()
  const ledgerPath = join(state, `${run}.json`)
  const receiver = join(state, `${run}.${dispatch}.receiver`)
  const ledger = {
    run_id: run,
    revision: 1,
    status: 'dispatched',
    coordinator: { task_id: coordinatorTaskId },
    outstanding_dispatch_id: dispatch,
    handled_dispatch_ids: [],
    attempt: { dispatch_id: dispatch, receiver_receipt_path: receiver },
    attempt_limits: { stop_at: STOP_AT },
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
  const base = [
    '--ledger', ledgerPath,
    '--tombstone', join(state, `${run}.tombstone`),
    '--receiver', receiver,
    '--run-id', run,
    '--dispatch-id', dispatch,
    '--coordinator-task-id', coordinatorTaskId,
    '--stop-at', STOP_AT,
  ]
  const invoke = (args, env = {}) => spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
  })
  const release = () => {
    const claim = invoke([join(candidate, 'scripts/receipt.mjs'), 'claim', ...base])
    assert.equal(claim.status, 0, claim.stderr)
    const receiverId = JSON.parse(claim.stdout).receiver_id
    const done = invoke([join(candidate, 'scripts/receipt.mjs'), 'release', ...base, '--receiver-id', receiverId, '--outcome', 'completed'])
    assert.equal(done.status, 0, done.stderr)
  }
  const reconcile = () => invoke([
    join(candidate, 'scripts/reconcile.mjs'), 'reconcile',
    '--ledger', ledgerPath,
    '--run-id', run,
    '--dispatch-id', dispatch,
    '--coordinator-task-id', coordinatorTaskId,
    '--expected-revision', '1',
  ])
  const entry = (command, expectedRevision) => invoke([
    coordinatorEntry, command,
    JSON.stringify({
      runId: run,
      dispatchId: dispatch,
      coordinatorTaskId,
      expectedRevision,
      messageType: 'completed',
      callbackDeliveryStatus: null,
      stateDir: state,
      ledgerPath,
    }),
  ], {
    ZCODE_CALLBACK_BRIDGE_RECONCILE: join(candidate, 'scripts/reconcile.mjs'),
  })
  return {
    temp, state, run, dispatch, coordinatorTaskId, ledgerPath, receiver,
    invoke, release, reconcile, entry,
    ledgerBytes: () => fs.readFileSync(ledgerPath),
  }
}

test('a synthetic valid Codex v7 task id reconciles and resumes through the coordinator entry CLI', () => {
  const f = fixture(SYNTHETIC_CODEX_V7)
  f.release()
  const consumed = f.entry('reconcile-receipt', 1)
  assert.equal(consumed.status, 0, `valid v7 coordinator id must reconcile: ${consumed.stderr}`)
  const parsed = JSON.parse(consumed.stdout)
  assert.equal(parsed.status, 'reviewing')
  assert.equal(parsed.revision, 2)
  assert.ok(parsed.holder_id, 'the retained review holder must be returned')
  const resumed = f.entry('review-holder', 2)
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.equal(JSON.parse(resumed.stdout).holder_id, parsed.holder_id)
  const after = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'))
  assert.equal(after.status, 'reviewing')
  assert.equal(after.revision, 2)
})

test('a different but valid v7 coordinator id is refused with bytes and locks unchanged', () => {
  const f = fixture(SYNTHETIC_CODEX_V7)
  f.release()
  const before = f.ledgerBytes()
  const differentV7 = 'abcdef01-0203-7405-8607-000000000000'
  const refused = f.invoke([
    join(candidate, 'scripts/reconcile.mjs'), 'reconcile',
    '--ledger', f.ledgerPath,
    '--run-id', f.run,
    '--dispatch-id', f.dispatch,
    '--coordinator-task-id', differentV7,
    '--expected-revision', '1',
  ])
  assert.notEqual(refused.status, 0, 'a mismatched coordinator id must not consume the dispatch')
  assert.match(refused.stderr, /coordinator task mismatch/)
  assert.equal(f.ledgerBytes().compare(before), 0, 'the ledger must stay untouched')
  assert.equal(fs.existsSync(join(f.state, `${f.run}.lock`)), false, 'no review lock may be created on refusal')
})

test('malformed, whitespace, and wrong-case coordinator ids are refused; empty is rejected at the CLI', () => {
  for (const bad of ['not-a-uuid', ' 01020304-0506-7708-9000-000000000000 ', 'ABCDEF01-0203-7405-8607-000000000000']) {
    const f = fixture(bad)
    f.release()
    const before = f.ledgerBytes()
    const refused = f.reconcile()
    assert.notEqual(refused.status, 0, `malformed coordinator id ${JSON.stringify(bad)} must be refused`)
    assert.equal(f.ledgerBytes().compare(before), 0, 'the ledger must stay untouched')
  }
  const empty = fixture(randomUUID())
  empty.release()
  const before = empty.ledgerBytes()
  const refused = empty.invoke([
    join(candidate, 'scripts/reconcile.mjs'), 'reconcile',
    '--ledger', empty.ledgerPath,
    '--run-id', empty.run,
    '--dispatch-id', empty.dispatch,
    '--coordinator-task-id', '',
    '--expected-revision', '1',
  ])
  assert.notEqual(refused.status, 0, 'an empty coordinator id must be refused')
  assert.equal(empty.ledgerBytes().compare(before), 0, 'the ledger must stay untouched')
})

test('v4 coordinator ids keep reconciling exactly as before', () => {
  const f = fixture(randomUUID())
  f.release()
  const consumed = f.reconcile()
  assert.equal(consumed.status, 0, consumed.stderr)
  const parsed = JSON.parse(consumed.stdout)
  assert.equal(parsed.status, 'reviewing')
  assert.equal(parsed.revision, 2)
})
