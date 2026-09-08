import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const candidate = process.env.CANDIDATE_BRIDGE
const coordinatorCandidate = process.env.COORDINATOR_CANDIDATE
assert.ok(candidate, 'CANDIDATE_BRIDGE must point at the candidate bridge directory')
assert.ok(coordinatorCandidate, 'COORDINATOR_CANDIDATE must point at the candidate coordinator entry')

const STOP_AT = '2099-01-01T00:00:00Z'

function fixture() {
  const temp = fs.mkdtempSync(join(tmpdir(), 'recovery-test-'))
  const state = join(temp, 'zcode-runs')
  fs.mkdirSync(state)
  const run = randomUUID()
  const dispatch = randomUUID()
  const coordinator = randomUUID()
  const ledgerPath = join(state, `${run}.json`)
  const receiver = join(state, `${run}.${dispatch}.receiver`)
  const ledger = {
    run_id: run,
    revision: 1,
    status: 'dispatched',
    coordinator: { task_id: coordinator },
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
    '--coordinator-task-id', coordinator,
    '--stop-at', STOP_AT,
  ]
  const receipt = join(candidate, 'scripts/receipt.mjs')
  const invoke = args => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 })
  const claim = invoke([receipt, 'claim', ...base])
  assert.equal(claim.status, 0, claim.stderr)
  const receiverId = JSON.parse(claim.stdout).receiver_id
  const reconcileArgs = [
    join(candidate, 'scripts/reconcile.mjs'), 'reconcile',
    '--ledger', ledgerPath,
    '--run-id', run,
    '--dispatch-id', dispatch,
    '--coordinator-task-id', coordinator,
    '--expected-revision', '1',
  ]
  return { temp, state, run, dispatch, coordinator, ledger, ledgerPath, receiver, invoke, reconcileArgs, release(outcome) {
    const done = invoke([receipt, 'release', ...base, '--receiver-id', receiverId, '--outcome', outcome])
    assert.equal(done.status, 0, done.stderr)
  } }
}

// Real child process that waits for the go file and exits with the real
// reconcile exit code, so the collected exit codes are genuine.
function barrierChild(go, ready, args) {
  const script = 'const{spawnSync}=require("node:child_process");const fs=require("node:fs");' +
    `fs.writeFileSync(${JSON.stringify(ready)}, "ready");` +
    `while(!fs.existsSync(${JSON.stringify(go)}));` +
    `const r=spawnSync(process.execPath,${JSON.stringify(args)},{encoding:"utf8"});` +
    `process.stdout.write("child:" + r.status + ":" + (r.stderr || ""));process.exit(r.status === null ? 1 : r.status)`
  return spawn(process.execPath, ['-e', script])
}

test('identity contradictions, active receipts, tombstones, and residual locks are refused with ledger bytes preserved', () => {
  for (const mode of ['wrong_ledger_run', 'wrong_attempt_dispatch', 'noncanonical_receiver', 'active_receipt', 'tombstone', 'residual_lock']) {
    const f = fixture()
    if (mode === 'active_receipt') {
      // receipt claimed but not released: still active, must not be consumed
    } else {
      f.release('completed')
    }
    if (mode !== 'active_receipt' && mode !== 'residual_lock' && mode !== 'tombstone') {
      // mutations for identity modes happen before the reference snapshot
    }
    if (mode === 'wrong_ledger_run') {
      f.ledger.run_id = randomUUID()
      const receiptPath = join(f.receiver, 'receipt.json')
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      receipt.run_id = f.ledger.run_id
      fs.writeFileSync(receiptPath, JSON.stringify(receipt))
    } else if (mode === 'wrong_attempt_dispatch') {
      f.ledger.attempt.dispatch_id = randomUUID()
    } else if (mode === 'noncanonical_receiver') {
      const unrelated = join(f.temp, 'unrelated-receiver')
      fs.renameSync(f.receiver, unrelated)
      f.ledger.attempt.receiver_receipt_path = unrelated
    }
    if (mode === 'wrong_ledger_run' || mode === 'wrong_attempt_dispatch' || mode === 'noncanonical_receiver') {
      fs.writeFileSync(f.ledgerPath, JSON.stringify(f.ledger))
    } else if (mode === 'tombstone') {
      fs.writeFileSync(join(f.state, `${f.run}.tombstone`), 'stopped')
    } else if (mode === 'residual_lock') {
      fs.mkdirSync(join(f.state, `${f.run}.lock`), { mode: 0o700 })
    }
    const before = fs.readFileSync(f.ledgerPath)
    const result = f.invoke(f.reconcileArgs)
    assert.notEqual(result.status, 0, `${mode} must be refused`)
    assert.equal(fs.readFileSync(f.ledgerPath).compare(before), 0, `${mode} must not touch the ledger`)
    assert.equal(JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')).status, 'dispatched')
  }
})

test('reconcile enters reviewing with a retained usable holder (resume route works)', () => {
  const f = fixture()
  f.release('completed')
  const result = f.invoke(f.reconcileArgs)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.status, 'reviewing')
  assert.equal(parsed.revision, 2)
  assert.equal(parsed.message_type, 'completed')
  assert.ok(parsed.holder_id, 'holder must be returned for the verdict step')
  const lockDir = join(f.state, `${f.run}.lock`)
  assert.ok(fs.existsSync(join(lockDir, 'holder.json')), 'review lock must be retained')
  const after = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'))
  assert.equal(after.status, 'reviewing')
  assert.deepEqual(after.handled_dispatch_ids, [f.dispatch])
  const resume = f.invoke([
    join(candidate, 'scripts/reconcile.mjs'), 'holder',
    '--ledger', f.ledgerPath,
    '--run-id', f.run,
    '--dispatch-id', f.dispatch,
    '--coordinator-task-id', f.coordinator,
    '--expected-revision', '2',
  ])
  assert.equal(resume.status, 0, resume.stderr)
  assert.equal(JSON.parse(resume.stdout).holder_id, parsed.holder_id)
})

test('second reconcile cannot double-consume or reset a handled dispatch', () => {
  const f = fixture()
  f.release('completed')
  assert.equal(f.invoke(f.reconcileArgs).status, 0)
  const reviewed = fs.readFileSync(f.ledgerPath)
  const again = f.invoke(f.reconcileArgs)
  assert.notEqual(again.status, 0)
  assert.equal(fs.readFileSync(f.ledgerPath).compare(reviewed), 0)
})

test('released blocked and needs_decision reach the stopped checkpoint exactly once', () => {
  for (const outcome of ['blocked', 'needs_decision']) {
    const f = fixture()
    f.release(outcome)
    const result = f.invoke(f.reconcileArgs)
    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.status, 'stopped')
    assert.equal(parsed.message_type, outcome)
    assert.equal(parsed.holder_id, undefined, 'a stopped checkpoint retains no verdict holder')
    const after = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'))
    assert.equal(after.status, 'stopped')
    assert.equal(after.message_type, outcome)
    assert.equal(after.outstanding_dispatch_id, null)
    assert.equal(after.revision, 2)
    assert.equal(typeof after.stop_reason, 'string')
    assert.ok(!fs.existsSync(join(f.state, `${f.run}.lock`)), 'stopped consumption must not leave a lock')
    const reviewed = fs.readFileSync(f.ledgerPath)
    const again = f.invoke(f.reconcileArgs)
    assert.notEqual(again.status, 0, 'stopped checkpoint must be consumed once')
    assert.equal(fs.readFileSync(f.ledgerPath).compare(reviewed), 0)
    const resume = f.invoke([
      join(candidate, 'scripts/reconcile.mjs'), 'holder',
      '--ledger', f.ledgerPath,
      '--run-id', f.run,
      '--dispatch-id', f.dispatch,
      '--coordinator-task-id', f.coordinator,
      '--expected-revision', '2',
    ])
    assert.notEqual(resume.status, 0, 'no holder may be resumed from a stopped checkpoint')
  }
})

test('symlinked receiver directory or receipt file is refused; a real receiver stays consumable', () => {
  for (const mode of ['symlink_receiver_dir', 'symlink_receipt_file']) {
    const f = fixture()
    f.release('completed')
    if (mode === 'symlink_receiver_dir') {
      const moved = join(f.temp, 'unrelated-receiver')
      fs.renameSync(f.receiver, moved)
      fs.symlinkSync(moved, f.receiver, 'dir')
    } else {
      const outside = join(f.temp, 'outside-receipt.json')
      fs.renameSync(join(f.receiver, 'receipt.json'), outside)
      fs.symlinkSync(outside, join(f.receiver, 'receipt.json'), 'file')
    }
    const before = fs.readFileSync(f.ledgerPath)
    const result = f.invoke(f.reconcileArgs)
    assert.notEqual(result.status, 0, `${mode} must be refused`)
    assert.equal(fs.readFileSync(f.ledgerPath).compare(before), 0, `${mode} must not touch the ledger`)
  }
})

test('review-holder resume demands exact revision, no tombstone, matching outstanding, and the recorded owner', () => {
  const f = fixture()
  f.release('completed')
  const consumed = f.invoke(f.reconcileArgs)
  assert.equal(consumed.status, 0, consumed.stderr)
  const newRevision = JSON.parse(consumed.stdout).revision
  assert.equal(newRevision, 2)
  const resumeWith = revision => f.invoke([
    join(candidate, 'scripts/reconcile.mjs'), 'holder',
    '--ledger', f.ledgerPath,
    '--run-id', f.run,
    '--dispatch-id', f.dispatch,
    '--coordinator-task-id', f.coordinator,
    '--expected-revision', String(revision),
  ])
  const stale = resumeWith(1)
  assert.notEqual(stale.status, 0, 'resume must not tolerate a stale revision')
  assert.equal(JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')).status, 'reviewing')
  const future = resumeWith(999)
  assert.notEqual(future.status, 0, 'resume must not tolerate an unknown future revision')
  const resumed = resumeWith(newRevision)
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.equal(JSON.parse(resumed.stdout).holder_id, JSON.parse(consumed.stdout).holder_id)

  const tombstoned = fixture()
  tombstoned.release('completed')
  assert.equal(tombstoned.invoke(tombstoned.reconcileArgs).status, 0)
  fs.writeFileSync(join(tombstoned.state, `${tombstoned.run}.tombstone`), 'stopped')
  assert.notEqual(tombstoned.invoke([
    join(candidate, 'scripts/reconcile.mjs'), 'holder',
    '--ledger', tombstoned.ledgerPath,
    '--run-id', tombstoned.run,
    '--dispatch-id', tombstoned.dispatch,
    '--coordinator-task-id', tombstoned.coordinator,
    '--expected-revision', '2',
  ]).status, 0, 'tombstone must bar the resume route')

  const moved = fixture()
  moved.release('completed')
  assert.equal(moved.invoke(moved.reconcileArgs).status, 0)
  const ledger = JSON.parse(fs.readFileSync(moved.ledgerPath, 'utf8'))
  ledger.outstanding_dispatch_id = randomUUID()
  fs.writeFileSync(moved.ledgerPath, JSON.stringify(ledger))
  assert.notEqual(moved.invoke([
    join(candidate, 'scripts/reconcile.mjs'), 'holder',
    '--ledger', moved.ledgerPath,
    '--run-id', moved.run,
    '--dispatch-id', moved.dispatch,
    '--coordinator-task-id', moved.coordinator,
    '--expected-revision', '2',
  ]).status, 0, 'mismatched outstanding dispatch must bar the resume route')
})

test('a receipt released inside its deadline is still accepted once after the deadline; active stays refused', () => {
  for (const outcome of ['completed', 'blocked']) {
    const temp = fs.mkdtempSync(join(tmpdir(), 'recovery-late-'))
    const state = join(temp, 'zcode-runs')
    fs.mkdirSync(state)
    const run = randomUUID()
    const dispatch = randomUUID()
    const coordinator = randomUUID()
    const stopAt = '2026-01-01T01:00:00Z'
    const ledgerPath = join(state, `${run}.json`)
    const receiver = join(state, `${run}.${dispatch}.receiver`)
    fs.mkdirSync(receiver)
    fs.writeFileSync(ledgerPath, JSON.stringify({
      run_id: run,
      revision: 1,
      status: 'dispatched',
      coordinator: { task_id: coordinator },
      outstanding_dispatch_id: dispatch,
      handled_dispatch_ids: [],
      attempt: { dispatch_id: dispatch, receiver_receipt_path: receiver },
      attempt_limits: { stop_at: stopAt },
    }))
    fs.writeFileSync(join(receiver, 'receipt.json'), JSON.stringify({
      protocol: 'zcode-callback-receipt/v1',
      run_id: run,
      dispatch_id: dispatch,
      coordinator_task_id: coordinator,
      stop_at: stopAt,
      receiver_id: randomUUID(),
      status: 'released',
      outcome,
      created_at: '2026-01-01T00:00:00Z',
      released_at: '2026-01-01T00:01:00Z',
    }))
    const args = [
      join(candidate, 'scripts/reconcile.mjs'), 'reconcile',
      '--ledger', ledgerPath,
      '--run-id', run,
      '--dispatch-id', dispatch,
      '--coordinator-task-id', coordinator,
      '--expected-revision', '1',
    ]
    const invoke = command => spawnSync(process.execPath, [
      join(candidate, 'scripts/reconcile.mjs'), command,
      '--ledger', ledgerPath,
      '--run-id', run,
      '--dispatch-id', dispatch,
      '--coordinator-task-id', coordinator,
      '--expected-revision', '2',
    ], { encoding: 'utf8', timeout: 15000 })
    const late = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 })
    assert.equal(late.status, 0, `late released ${outcome} must be accepted once: ${late.stderr}`)
    const parsed = JSON.parse(late.stdout)
    const expected = outcome === 'completed' ? 'reviewing' : 'stopped'
    assert.equal(parsed.status, expected)
    const after = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    assert.equal(after.status, expected)
    assert.deepEqual(after.handled_dispatch_ids, [dispatch])
    const before = fs.readFileSync(ledgerPath)
    const replay = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 })
    assert.notEqual(replay.status, 0, 'late result must be consumed exactly once')
    assert.equal(fs.readFileSync(ledgerPath).compare(before), 0)
    const resume = invoke('holder')
    if (outcome === 'completed') assert.equal(resume.status, 0, resume.stderr)
    else assert.notEqual(resume.status, 0, 'stopped checkpoint keeps no resume holder')
  }

  const active = fs.mkdtempSync(join(tmpdir(), 'recovery-late-active-'))
  const state = join(active, 'zcode-runs')
  fs.mkdirSync(state)
  const run = randomUUID()
  const dispatch = randomUUID()
  const coordinator = randomUUID()
  const ledgerPath = join(state, `${run}.json`)
  const receiver = join(state, `${run}.${dispatch}.receiver`)
  fs.mkdirSync(receiver)
  fs.writeFileSync(ledgerPath, JSON.stringify({
    run_id: run,
    revision: 1,
    status: 'dispatched',
    coordinator: { task_id: coordinator },
    outstanding_dispatch_id: dispatch,
    handled_dispatch_ids: [],
    attempt: { dispatch_id: dispatch, receiver_receipt_path: receiver },
    attempt_limits: { stop_at: '2026-01-01T01:00:00Z' },
  }))
  fs.writeFileSync(join(receiver, 'receipt.json'), JSON.stringify({
    protocol: 'zcode-callback-receipt/v1',
    run_id: run,
    dispatch_id: dispatch,
    coordinator_task_id: coordinator,
    stop_at: '2026-01-01T01:00:00Z',
    receiver_id: randomUUID(),
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
  }))
  const before = fs.readFileSync(ledgerPath)
  const refused = spawnSync(process.execPath, [
    join(candidate, 'scripts/reconcile.mjs'), 'reconcile',
    '--ledger', ledgerPath,
    '--run-id', run,
    '--dispatch-id', dispatch,
    '--coordinator-task-id', coordinator,
    '--expected-revision', '1',
  ], { encoding: 'utf8', timeout: 15000 })
  assert.notEqual(refused.status, 0, 'an active receipt must never be consumed, late or not')
  assert.equal(fs.readFileSync(ledgerPath).compare(before), 0)
})

// --- ReconcileLockRepair: fault-injected cleanup and commit-phase tests ---

const faultPreload = join(candidate, 'tests/fixtures/reconcile-fault-preload.mjs')

function faultFixture() {
  const temp = fs.mkdtempSync(join(tmpdir(), 'recovery-fault-'))
  const state = join(temp, 'zcode-runs')
  fs.mkdirSync(state)
  const run = randomUUID()
  const dispatch = randomUUID()
  const coordinator = randomUUID()
  const stopAt = '2099-01-01T00:00:00Z'
  const ledgerPath = join(state, `${run}.json`)
  const receiver = join(state, `${run}.${dispatch}.receiver`)
  fs.mkdirSync(receiver)
  fs.writeFileSync(ledgerPath, JSON.stringify({
    run_id: run,
    revision: 1,
    status: 'dispatched',
    coordinator: { task_id: coordinator },
    outstanding_dispatch_id: dispatch,
    handled_dispatch_ids: [],
    attempt: { dispatch_id: dispatch, receiver_receipt_path: receiver },
    attempt_limits: { stop_at: stopAt },
  }))
  fs.writeFileSync(join(receiver, 'receipt.json'), JSON.stringify({
    protocol: 'zcode-callback-receipt/v1',
    run_id: run,
    dispatch_id: dispatch,
    coordinator_task_id: coordinator,
    stop_at: stopAt,
    receiver_id: randomUUID(),
    status: 'released',
    outcome: 'completed',
  }))
  const base = [
    '--ledger', ledgerPath,
    '--run-id', run,
    '--dispatch-id', dispatch,
    '--coordinator-task-id', coordinator,
  ]
  const invokeFault = (mode, command = 'reconcile') => spawnSync(process.execPath,
    ['--import', faultPreload, join(candidate, 'scripts/reconcile.mjs'), command,
      ...base, '--expected-revision', command === 'holder' ? '2' : '1'], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, RECONCILE_FAULT_ROOT: temp, RECONCILE_FAULT_MODE: mode },
  })
  const invokeClean = (command = 'reconcile', revision = '1') => spawnSync(process.execPath,
    [join(candidate, 'scripts/reconcile.mjs'), command, ...base, '--expected-revision', revision], {
    encoding: 'utf8',
    timeout: 15000,
  })
  return { temp, state, run, dispatch, coordinator, ledgerPath, receiver, base, invokeFault, invokeClean }
}

test('a pre-commit write failure by the proven owner stands down to abandoned evidence and retries once', () => {
  const f = faultFixture()
  const before = fs.readFileSync(f.ledgerPath)
  const fault = f.invokeFault('ledger_open_eacces')
  assert.equal(fault.status, 1, 'the injected fault must fail the run')
  assert.match(fault.stderr, /TEST_INJECTED_EACCES_BEFORE_LEDGER_WRITE/)
  assert.equal(fs.readFileSync(f.ledgerPath).compare(before), 0, 'pre-commit failure must not touch the ledger')
  assert.equal(JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')).status, 'dispatched')
  assert.equal(fs.existsSync(join(f.state, `${f.run}.lock`)), false, 'the proven owner must stand down its lock')
  const abandoned = fs.readdirSync(f.state).filter(name => name.startsWith(`${f.run}.lock.abandoned-`))
  assert.equal(abandoned.length, 1, 'exactly one abandoned evidence sibling must remain')
  const retry = f.invokeClean()
  assert.equal(retry.status, 0, `retry after the fault clears must reconcile once: ${retry.stderr}`)
  const after = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'))
  assert.equal(after.status, 'reviewing')
  assert.deepEqual(after.handled_dispatch_ids, [f.dispatch])
})

test('the same revision under a different holder must not be cleaned up', () => {
  const f = faultFixture()
  const before = fs.readFileSync(f.ledgerPath)
  const fault = f.invokeFault('owner_swap')
  assert.equal(fault.status, 1, 'a swapped holder must fail holder verification')
  assert.match(fault.stderr, /review holder verification failed/)
  assert.equal(fs.readFileSync(f.ledgerPath).compare(before), 0)
  assert.equal(fs.existsSync(join(f.state, `${f.run}.lock`)), true, 'a foreign holder lock must stay untouched')
  const abandoned = fs.readdirSync(f.state).filter(name => name.startsWith(`${f.run}.lock.abandoned-`))
  assert.equal(abandoned.length, 0, 'a foreign holder must never be moved or cleaned')
  const retry = f.invokeClean()
  assert.notEqual(retry.status, 0, 'a residual foreign lock must keep blocking retries')
})

test('a post-rename directory fsync failure is a committed unknown, kept fail-closed with its holder', () => {
  const f = faultFixture()
  const fault = f.invokeFault('state_fsync_after_rename')
  assert.equal(fault.status, 1, 'the injected fsync fault must fail the run')
  assert.match(fault.stderr, /TEST_INJECTED_FSYNC_FAILURE_AFTER_LEDGER_RENAME/)
  const after = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'))
  assert.equal(after.status, 'reviewing', 'the rename is the commit point: the consumption landed')
  assert.equal(after.revision, 2)
  assert.deepEqual(after.handled_dispatch_ids, [f.dispatch])
  assert.equal(fs.existsSync(join(f.state, `${f.run}.lock`)), true, 'committed unknowns keep the lock as the inspectable scene')
  assert.equal(fs.readdirSync(f.state).filter(name => name.startsWith(`${f.run}.lock.abandoned-`)).length, 0)
  const replay = f.invokeClean()
  assert.notEqual(replay.status, 0, 'a committed consumption must never be replayed')
  const resume = f.invokeClean('holder', '2')
  assert.equal(resume.status, 0, `the review holder must survive for verdict continuation: ${resume.stderr}`)
})

test('concurrent reconciles synchronize on a real ready/go barrier and exactly one wins', async () => {
  const f = fixture()
  f.release('completed')
  const go = join(f.temp, 'go')
  const readyA = join(f.temp, 'ready-a')
  const readyB = join(f.temp, 'ready-b')
  const childA = barrierChild(go, readyA, f.reconcileArgs)
  const childB = barrierChild(go, readyB, f.reconcileArgs)
  const deadline = Date.now() + 15000
  while ((!fs.existsSync(readyA) || !fs.existsSync(readyB)) && Date.now() < deadline) {
    await new Promise(resolveChild => setTimeout(resolveChild, 10))
  }
  assert.ok(fs.existsSync(readyA) && fs.existsSync(readyB), 'both racers must be ready before the barrier opens')
  fs.writeFileSync(go, 'go')
  const codes = await Promise.all([childA, childB].map(proc => new Promise(resolveChild => proc.on('close', code => resolveChild(code)))))
  assert.deepEqual(codes.slice().sort(), [0, 1], 'exactly one racer may win')
  const after = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'))
  assert.equal(after.status, 'reviewing')
  assert.equal(after.revision, 2)
  assert.deepEqual(after.handled_dispatch_ids, [f.dispatch])
})

test('normal callback consumption and reconciliation contend through the real entries and consume once', async () => {
  const f = fixture()
  f.release('completed')
  const go = join(f.temp, 'go')
  const readyA = join(f.temp, 'ready-a')
  const readyB = join(f.temp, 'ready-b')
  const entryConfig = JSON.stringify({
    runId: f.run,
    dispatchId: f.dispatch,
    coordinatorTaskId: f.coordinator,
    expectedRevision: 1,
    messageType: 'completed',
    callbackDeliveryStatus: null,
    stateDir: f.state,
    ledgerPath: f.ledgerPath,
  })
  const script = 'const{spawnSync}=require("node:child_process");const fs=require("node:fs");' +
    `fs.writeFileSync(${JSON.stringify(readyB)}, "ready");` +
    `while(!fs.existsSync(${JSON.stringify(go)}));` +
    `const r=spawnSync(process.execPath,[${JSON.stringify(coordinatorCandidate)},"review-completed",${JSON.stringify(entryConfig)}],` +
    '{encoding:"utf8",env:{...process.env,ZCODE_CALLBACK_BRIDGE_RECONCILE:' + JSON.stringify(join(candidate, 'scripts/reconcile.mjs')) + '}});' +
    'process.stdout.write("entry:" + r.status + ":" + (r.stderr || ""));process.exit(r.status === null ? 1 : r.status)'
  const childA = barrierChild(go, readyA, f.reconcileArgs)
  const childB = spawn(process.execPath, ['-e', script])
  const deadline = Date.now() + 15000
  while ((!fs.existsSync(readyA) || !fs.existsSync(readyB)) && Date.now() < deadline) {
    await new Promise(resolveChild => setTimeout(resolveChild, 10))
  }
  assert.ok(fs.existsSync(readyA) && fs.existsSync(readyB), 'both real entries must be ready before the barrier opens')
  fs.writeFileSync(go, 'go')
  const codes = await Promise.all([childA, childB].map(proc => new Promise(resolveChild => proc.on('close', code => resolveChild(code)))))
  assert.deepEqual(codes.slice().sort(), [0, 1], 'exactly one real entry may consume the dispatch')
  const after = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'))
  assert.equal(after.status, 'reviewing')
  assert.equal(after.revision, 2)
  assert.deepEqual(after.handled_dispatch_ids, [f.dispatch])
})
