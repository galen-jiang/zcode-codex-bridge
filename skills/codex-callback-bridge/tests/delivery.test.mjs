import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const script = new URL('../scripts/delivery.mjs', import.meta.url)
const legacyScript = new URL('../scripts/receipt.mjs', import.meta.url)
const legacyTests = new URL('../tests/receipt.test.mjs', import.meta.url)

const runId = '11111111-1111-4111-8111-111111111111'
const dispatchId = '22222222-2222-4222-8222-222222222222'
const receiverId = '44444444-4444-4444-8444-444444444444'
const coordinatorTaskId = '01TESTTASK'
const workStopAt = '2099-01-01T00:00:00+00:00'
const t0 = 1_000_000_000_000
const ts = (ms) => new Date(t0 + ms).toISOString()
const TARGET_CHECK_MAX_AGE_MS = 30_000
const constants_O_CREAT = fsConstants.O_CREAT
const constants_O_TRUNC = fsConstants.O_TRUNC
const constants_O_RDWR = fsConstants.O_RDWR

function waitQuiet(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {}
}

async function waitFor(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function exitOf(child, timeoutMs = 5000) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    const timer = setTimeout(() => resolve(null), timeoutMs)
    child.on('close', code => { clearTimeout(timer); resolve(code) })
  })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fixture(t, options = {}) {
  const outcome = options.outcome ?? 'completed'
  const root = mkdtempSync(join(tmpdir(), 'zcode-callback-delivery-'))
  const stateDir = join(root, 'deliveries')
  mkdirSync(stateDir)
  const runsDir = join(root, 'zcode-runs')
  mkdirSync(runsDir)
  const receiver = join(runsDir, `${runId}.${dispatchId}.receiver`)
  mkdirSync(receiver, { mode: 0o700 })
  writeFileSync(join(runsDir, `${runId}.json`), `${JSON.stringify({
    run_id: runId,
    coordinator: { task_id: coordinatorTaskId },
    status: 'dispatched',
    outstanding_dispatch_id: dispatchId,
    handled_dispatch_ids: [],
    attempt_limits: { stop_at: workStopAt },
    attempt: { dispatch_id: dispatchId, receiver_receipt_path: receiver },
  })}\n`)
  writeFileSync(join(receiver, 'receipt.json'), `${JSON.stringify({
    protocol: 'zcode-callback-receipt/v1',
    run_id: runId,
    dispatch_id: dispatchId,
    coordinator_task_id: coordinatorTaskId,
    stop_at: workStopAt,
    receiver_id: receiverId,
    status: 'released',
    outcome,
    released_at: ts(0),
  }, null, 2)}\n`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    root,
    stateDir,
    receiver,
    receiptPath: join(receiver, 'receipt.json'),
    state: join(stateDir, `${runId}.${dispatchId}.pending.json`),
    lock: join(stateDir, `${runId}.${dispatchId}.attempt.lock`),
    deliveryDeadline: ts(3_600_000),
    outcome,
  }
}

function enqueueArgs(paths, extra = [], overrides = {}) {
  return [
    script.pathname,
    'enqueue',
    '--state-dir', paths.stateDir,
    '--run-id', runId,
    '--dispatch-id', dispatchId,
    '--coordinator-task-id', coordinatorTaskId,
    '--codex-project', 'demo-project',
    '--codex-task-title', 'demo title for delivery tests',
    '--ledger-path', join(paths.root, 'zcode-runs', `${runId}.json`),
    '--tombstone-path', join(paths.root, 'zcode-runs', `${runId}.tombstone`),
    '--receiver-path', paths.receiver,
    '--receipt-dir', paths.receiver,
    '--message-type', overrides.messageType ?? paths.outcome,
    '--work-stop-at', workStopAt,
    '--delivery-deadline', overrides.deliveryDeadline ?? paths.deliveryDeadline,
    '--max-attempts', '3',
    '--backoff-base-ms', '1000',
    '--backoff-cap-ms', '5000',
    '--now', String(t0),
    ...extra,
  ]
}

function invoke(args, extraEnv = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...extraEnv } })
}

function enqueue(t, paths, extra = []) {
  const result = invoke(enqueueArgs(paths, extra))
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function begin(paths, { owner, pid = process.pid, verifiedAt = t0, now = t0 } = {}) {
  return invoke([
    script.pathname,
    'begin-attempt',
    '--state', paths.state,
    '--owner', owner,
    '--owner-pid', String(pid),
    '--target-verified-at', String(verifiedAt),
    '--now', String(now),
  ])
}

function record(paths, { owner, pid = process.pid, result, evidence, draft, observedMessage, now = t0 }) {
  const args = [
    script.pathname,
    'record-result',
    '--state', paths.state,
    '--owner', owner,
    '--owner-pid', String(pid),
    '--result', result,
    '--evidence', evidence,
    '--now', String(now),
  ]
  if (draft !== undefined) args.push('--draft-present', draft)
  if (observedMessage !== undefined) args.push('--observed-message', observedMessage)
  return invoke(args)
}

function status(paths, { now = t0 } = {}) {
  const result = invoke([script.pathname, 'status', '--state', paths.state, '--now', String(now)])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function expectedMessage(outcome) {
  const firstLine = {
    completed: '已完成，等待下一步指示',
    blocked: '任务受阻，等待下一步指示',
    needs_decision: '需要决策，等待下一步指示',
  }[outcome]
  return [
    firstLine,
    `message_type: ${outcome}`,
    `run_id: ${runId}`,
    `dispatch_id: ${dispatchId}`,
  ].join('\n')
}

test('enqueue binds a pending record to the exact released receipt and derives an immutable message', (t) => {
  const paths = fixture(t)
  const created = enqueue(t, paths)
  assert.equal(created.created, true)
  const pending = JSON.parse(readFileSync(paths.state, 'utf8'))
  assert.equal(pending.protocol, 'zcode-callback-delivery/v1')
  assert.equal(pending.state, 'queued')
  assert.equal(pending.envelope.run_id, runId)
  assert.equal(pending.envelope.dispatch_id, dispatchId)
  assert.equal(pending.envelope.coordinator_task_id, coordinatorTaskId)
  assert.equal(pending.receipt.receiver_id, receiverId)
  assert.equal(pending.receipt.outcome, paths.outcome)
  assert.equal(pending.receipt.status, 'released')
  assert.equal(pending.delivery_deadline, paths.deliveryDeadline)
  assert.equal(pending.attempts, 0)
  assert.equal(pending.message.message_type, paths.outcome)

  const shown = status(paths)
  assert.equal(shown.message_text, expectedMessage(paths.outcome))
  assert.equal(shown.attempts, 0)
  assert.equal(shown.delivery_deadline, paths.deliveryDeadline)
  assert.equal(shown.recommended_action, 'resume_attempt')

  const repeated = enqueue(t, paths)
  assert.equal(repeated.created, false)
  assert.equal(JSON.stringify(status(paths).message_text), JSON.stringify(shown.message_text))
})

test('enqueue rejects a message type that does not match the released receipt outcome', (t) => {
  const paths = fixture(t, { outcome: 'blocked' })
  const result = invoke(enqueueArgs(paths, [], { messageType: 'completed' }))
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('message type does not match released receipt outcome'), true)
  assert.equal(existsSync(paths.state), false)
})

test('enqueue rejects forged, unfinished, or unreadable receipts and unsafe state paths', (t) => {
  const active = fixture(t)
  const receipt = JSON.parse(readFileSync(active.receiptPath, 'utf8'))
  receipt.status = 'active'
  writeFileSync(active.receiptPath, `${JSON.stringify(receipt)}\n`)
  const unfinished = invoke(enqueueArgs(active))
  assert.notEqual(unfinished.status, 0)
  assert.equal(unfinished.stderr.includes('receipt is not a released terminal receipt'), true)

  const forged = fixture(t)
  const forgedReceipt = JSON.parse(readFileSync(forged.receiptPath, 'utf8'))
  forgedReceipt.run_id = '99999999-9999-4999-8999-999999999999'
  writeFileSync(forged.receiptPath, `${JSON.stringify(forgedReceipt)}\n`)
  const forgedResult = invoke(enqueueArgs(forged))
  assert.notEqual(forgedResult.status, 0)
  assert.equal(forgedResult.stderr.includes('released receipt identity mismatch'), true)

  const unreadable = fixture(t)
  rmSync(unreadable.receiptPath)
  const unreadableResult = invoke(enqueueArgs(unreadable))
  assert.notEqual(unreadableResult.status, 0)

  const symlinked = fixture(t)
  rmSync(symlinked.receiptPath)
  symlinkSync(join(symlinked.root, 'outside.json'), symlinked.receiptPath)
  const symlinkResult = invoke(enqueueArgs(symlinked))
  assert.notEqual(symlinkResult.status, 0)
  assert.equal(symlinkResult.stderr.includes('must be a regular file'), true)

  const linkedStateDir = fixture(t)
  const outsideDir = join(linkedStateDir.root, 'outside-deliveries')
  mkdirSync(outsideDir)
  rmSync(linkedStateDir.stateDir, { recursive: true })
  symlinkSync(outsideDir, linkedStateDir.stateDir)
  t.after(() => rmSync(linkedStateDir.stateDir, { force: true }))
  const linkedResult = invoke(enqueueArgs(linkedStateDir))
  assert.notEqual(linkedResult.status, 0)
  assert.equal(linkedResult.stderr.includes('must be a real directory'), true)
})

test('enqueue refuses a delivery deadline that has already passed', (t) => {
  const paths = fixture(t)
  const result = invoke(enqueueArgs(paths, [], { deliveryDeadline: ts(-1) }))
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('delivery deadline has already passed'), true)
  assert.equal(existsSync(paths.state), false)
})

test('a clearly-unsent failure schedules a bounded backoff and then allows exactly one retry at a time', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const started = begin(paths, { owner: 'worker-a', verifiedAt: t0, now: t0 })
  assert.equal(started.status, 0, started.stderr)

  const refusedEarly = begin(paths, { owner: 'worker-b', verifiedAt: ts(1), now: ts(1) })
  assert.notEqual(refusedEarly.status, 0)
  assert.equal(refusedEarly.stderr.includes('attempt lock held'), true)

  const unsent = record(paths, {
    owner: 'worker-a',
    result: 'unsent',
    evidence: 'action_sent=false; Codex foreground is another session',
    draft: 'true',
    now: t0 + 100,
  })
  assert.equal(unsent.status, 0, unsent.stderr)
  const afterFailure = status(paths, { now: t0 + 100 })
  assert.equal(afterFailure.state, 'waiting_backoff')
  assert.equal(afterFailure.attempts, 1)
  assert.equal(afterFailure.next_eligible_at, ts(1100))
  assert.equal(afterFailure.recommended_action, 'wait_and_retry')

  const beforeEligible = begin(paths, { owner: 'worker-a', verifiedAt: t0 + 500, now: t0 + 500 })
  assert.notEqual(beforeEligible.status, 0)
  assert.equal(beforeEligible.stderr.includes('backoff has not elapsed'), true)

  const retry = begin(paths, { owner: 'worker-a', verifiedAt: t0 + 1100, now: t0 + 1100 })
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(status(paths, { now: t0 + 1100 }).state, 'in_attempt')
})

test('begin-attempt requires a fresh re-verification of the target, not a pre-wait attestation', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'worker-a', verifiedAt: t0, now: t0 }).status, 0)
  assert.equal(record(paths, {
    owner: 'worker-a',
    result: 'unsent',
    evidence: 'focus conflict',
    now: t0 + 100,
  }).status, 0)

  const staleCheck = begin(paths, { owner: 'worker-a', verifiedAt: t0 + 100, now: t0 + 1100 })
  assert.notEqual(staleCheck.status, 0)
  assert.equal(staleCheck.stderr.includes('target verification is stale'), true)

  const predatingCheck = begin(paths, { owner: 'worker-a', verifiedAt: t0 + 50, now: t0 + 1100 })
  assert.notEqual(predatingCheck.status, 0)
  assert.equal(predatingCheck.stderr.includes('target verification is stale'), true)

  const futureCheck = begin(paths, { owner: 'worker-a', verifiedAt: t0 + 1200, now: t0 + 1100 })
  assert.notEqual(futureCheck.status, 0)

  const fresh = begin(paths, { owner: 'worker-a', verifiedAt: t0 + 1090, now: t0 + 1100 })
  assert.equal(fresh.status, 0, fresh.stderr)
})

test('unsent results record the preserved user draft and never authorize destructive input actions', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'worker-a', now: t0 }).status, 0)
  assert.equal(record(paths, {
    owner: 'worker-a',
    result: 'unsent',
    evidence: 'input box holds an unrelated user draft; draft left untouched',
    draft: 'true',
    now: t0 + 10,
  }).status, 0)

  const pending = JSON.parse(readFileSync(paths.state, 'utf8'))
  const last = pending.history.at(-1)
  assert.equal(last.event, 'record_result')
  assert.equal(last.result, 'unsent')
  assert.equal(last.draft_present, true)
  assert.equal(pending.last_error.draft_present, true)

  const shown = JSON.stringify(status(paths))
  assert.equal(shown.includes('clear_input'), false)
  assert.equal(shown.includes('close_session'), false)
  assert.equal(shown.includes('focus_steal'), false)
})

test('a sent-but-unconfirmed result keeps needs_verification and refuses a blind re-send', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'worker-a', now: t0 }).status, 0)
  const uncertain = record(paths, {
    owner: 'worker-a',
    result: 'sent_unconfirmed',
    evidence: 'send dispatched but the confirmation re-read timed out',
    now: t0 + 100,
  })
  assert.equal(uncertain.status, 0, uncertain.stderr)

  const afterUncertain = status(paths, { now: t0 + 100 })
  assert.equal(afterUncertain.state, 'needs_verification')
  assert.equal(afterUncertain.recommended_action, 'verify_existing')

  const blindRetry = begin(paths, { owner: 'worker-a', verifiedAt: ts(60_000), now: ts(60_000) })
  assert.notEqual(blindRetry.status, 0)
  assert.equal(blindRetry.stderr.includes('needs_verification'), true)
})

test('verification that finds the full message confirms delivery without another send', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'worker-a', now: t0 }).status, 0)
  assert.equal(record(paths, {
    owner: 'worker-a',
    result: 'sent_unconfirmed',
    evidence: 'confirmation read lost',
    now: t0 + 100,
  }).status, 0)

  const found = invoke([
    script.pathname,
    'verify',
    '--state', paths.state,
    '--owner', 'worker-a',
    '--found', 'true',
    '--evidence', 're-read shows all four lines together in the final block',
    '--observed-message', expectedMessage(paths.outcome),
    '--owner-pid', String(process.pid),
    '--target-verified-at', String(t0 + 200),
    '--now', String(t0 + 200),
  ])
  assert.equal(found.status, 0, found.stderr)
  const confirmed = status(paths, { now: t0 + 200 })
  assert.equal(confirmed.state, 'confirmed')
  assert.equal(confirmed.recommended_action, 'none_confirmed')

  const resend = begin(paths, { owner: 'worker-b', verifiedAt: ts(60_000), now: ts(60_000) })
  assert.notEqual(resend.status, 0)
  assert.equal(resend.stderr.includes('already confirmed'), true)
})

test('verification that proves absence returns to backoff and the attempt budget stays bounded', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'worker-a', now: t0 }).status, 0)
  assert.equal(record(paths, {
    owner: 'worker-a',
    result: 'sent_unconfirmed',
    evidence: 'confirmation read lost',
    now: t0 + 100,
  }).status, 0)

  const absent = invoke([
    script.pathname,
    'verify',
    '--state', paths.state,
    '--owner', 'worker-a',
    '--found', 'false',
    '--evidence', 'full final block read; the four lines are not present',
    '--owner-pid', String(process.pid),
    '--target-verified-at', String(t0 + 200),
    '--now', String(t0 + 200),
  ])
  assert.equal(absent.status, 0, absent.stderr)
  const backoff = status(paths, { now: t0 + 200 })
  assert.equal(backoff.state, 'waiting_backoff')
  assert.equal(backoff.attempts, 1)

  for (const [owner, at, verifiedAt] of [
    ['worker-a', 1200, 1200],
    ['worker-a', 5300, 5300],
  ]) {
    assert.equal(begin(paths, { owner, verifiedAt: t0 + verifiedAt, now: t0 + at }).status, 0)
    assert.equal(record(paths, {
      owner,
      result: 'sent_unconfirmed',
      evidence: 'confirmation read lost again',
      now: t0 + at + 50,
    }).status, 0)
    assert.equal(invoke([
      script.pathname, 'verify',
      '--state', paths.state,
      '--owner', owner,
      '--found', 'false',
      '--evidence', 'still absent',
      '--owner-pid', String(process.pid),
      '--target-verified-at', String(t0 + at + 60),
      '--now', String(t0 + at + 60),
    ]).status, 0)
  }

  const exhausted = status(paths, { now: t0 + 5400 })
  assert.equal(exhausted.state, 'parked')
  assert.equal(exhausted.recommended_action, 'manual_review')
  assert.match(JSON.stringify(exhausted.last_error), /attempt budget exhausted/)
  assert.equal(begin(paths, { owner: 'worker-c', verifiedAt: ts(60_000), now: ts(60_000) }).status !== 0, true)
})

test('two concurrent recoverers cannot both send; a live lock is never taken or stolen', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  t.after(() => { holder.kill('SIGKILL') })
  try {
    const acquired = begin(paths, { owner: 'holder', pid: holder.pid, now: t0 })
    assert.equal(acquired.status, 0, acquired.stderr)

    const second = begin(paths, { owner: 'rival', pid: process.pid, verifiedAt: t0, now: t0 + 50 })
    assert.notEqual(second.status, 0)
    assert.equal(second.stderr.includes('attempt lock held'), true)
    assert.equal(status(paths, { now: t0 + 50 }).state, 'in_attempt')

    const foreignRecord = record(paths, {
      owner: 'rival',
      result: 'unsent',
      evidence: 'rival tries to record a send',
      now: t0 + 60,
    })
    assert.notEqual(foreignRecord.status, 0)
    assert.equal(status(paths, { now: t0 + 60 }).attempts, 0)

    const confirmed = record(paths, {
      owner: 'holder',
      pid: holder.pid,
      result: 'confirmed',
      evidence: 'four lines visible',
      observedMessage: expectedMessage(paths.outcome),
      now: t0 + 70,
    })
    assert.equal(confirmed.status, 0, confirmed.stderr)
    assert.equal(existsSync(paths.lock), false)
    assert.equal(status(paths, { now: t0 + 70 }).state, 'confirmed')
  } finally {
    holder.kill('SIGKILL')
  }
})

test('a stale lock from a dead owner is never stolen by waiting, only by explicit reclaim', async (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const doomed = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  const deadPid = doomed.pid
  doomed.kill('SIGKILL')
  await new Promise(resolve => doomed.on('close', resolve))

  assert.equal(begin(paths, { owner: 'crashed', pid: deadPid, now: t0 }).status, 0)
  assert.equal(record(paths, {
    owner: 'crashed',
    pid: deadPid,
    result: 'unsent',
    evidence: 'attempted once before crash',
    now: t0 + 100,
  }).status, 0)
  // The owner starts a second attempt and then "dies" mid-attempt, leaving the lock behind.
  assert.equal(begin(paths, { owner: 'crashed', pid: deadPid, verifiedAt: t0 + 1100, now: t0 + 1100 }).status, 0)
  const crashedAt = t0 + 1100

  const byWaiting = begin(paths, {
    owner: 'restarter',
    pid: process.pid,
    verifiedAt: crashedAt + 60_000,
    now: crashedAt + 60_000,
  })
  assert.notEqual(byWaiting.status, 0)
  assert.equal(byWaiting.stderr.includes('stale attempt lock requires explicit reclaim'), true)

  const wrongName = invoke([
    script.pathname, 'reclaim-stale-lock',
    '--state', paths.state,
    '--owner', 'restarter',
    '--prior-owner', 'someone-else',
    '--evidence', 'guessing the old owner',
    '--now', String(crashedAt + 60_000 + 10),
  ])
  assert.notEqual(wrongName.status, 0)

  const reclaimed = invoke([
    script.pathname, 'reclaim-stale-lock',
    '--state', paths.state,
    '--owner', 'restarter',
    '--prior-owner', 'crashed',
    '--evidence', 'holder pid is gone; restart continuation of the same dispatch',
    '--now', String(crashedAt + 60_000 + 20),
  ])
  assert.equal(reclaimed.status, 0, reclaimed.stderr)
  assert.equal(existsSync(paths.lock), false)

  const resumed = status(paths, { now: crashedAt + 60_000 + 20 })
  assert.equal(resumed.state, 'needs_verification')
  assert.equal(resumed.attempts, 1)
  assert.equal(resumed.delivery_deadline, paths.deliveryDeadline)
  assert.match(JSON.stringify(resumed.history), /lock_reclaimed/)

  const sendBeforeVerify = begin(paths, {
    owner: 'restarter',
    pid: process.pid,
    verifiedAt: crashedAt + 60_000 + 30,
    now: crashedAt + 60_000 + 30,
  })
  assert.notEqual(sendBeforeVerify.status, 0)
  assert.equal(sendBeforeVerify.stderr.includes('needs_verification'), true)

  const absent = invoke([
    script.pathname, 'verify',
    '--state', paths.state,
    '--owner', 'restarter',
    '--found', 'false',
    '--evidence', 'full final block read after reclaim; the four lines are not present',
    '--observed-message', expectedMessage(paths.outcome),
    '--owner-pid', String(process.pid),
    '--target-verified-at', String(crashedAt + 60_000 + 40),
    '--now', String(crashedAt + 60_000 + 40),
  ])
  assert.equal(absent.status, 0, absent.stderr)
  const afterVerify = status(paths, { now: crashedAt + 60_000 + 40 })
  assert.equal(afterVerify.state, 'waiting_backoff')
  assert.equal(afterVerify.attempts, 2)
})

test('a crash that leaves in_attempt without a lock self-heals to needs_verification before any re-send', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'worker-a', now: t0 }).status, 0)
  rmSync(paths.lock, { force: true })
  // Simulate the crash window: the state file still says in_attempt but the lock is gone.
  const healed = begin(paths, { owner: 'worker-b', verifiedAt: t0 + 1, now: t0 + 1 })
  assert.notEqual(healed.status, 0)
  assert.equal(healed.stderr.includes('needs_verification'), true)
  const shown = status(paths, { now: t0 + 2 })
  assert.equal(shown.state, 'needs_verification')
  assert.match(JSON.stringify(shown.history), /crash_self_heal/)

  const confirmedWithoutResend = invoke([
    script.pathname, 'verify',
    '--state', paths.state,
    '--owner', 'worker-b',
    '--found', 'true',
    '--evidence', 're-read shows the four lines; the crashed attempt did deliver',
    '--observed-message', expectedMessage(paths.outcome),
    '--owner-pid', String(process.pid),
    '--target-verified-at', String(t0 + 3),
    '--now', String(t0 + 3),
  ])
  assert.equal(confirmedWithoutResend.status, 0, confirmedWithoutResend.stderr)
  assert.equal(status(paths, { now: t0 + 4 }).state, 'confirmed')
})

test('owner tokens are bound to their process: same token under another pid cannot act', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'solo', pid: process.pid, now: t0 }).status, 0)

  const clonedToken = begin(paths, { owner: 'solo', pid: 1, verifiedAt: t0, now: t0 + 1 })
  assert.notEqual(clonedToken.status, 0)
  assert.equal(clonedToken.stderr.includes('unique per recoverer'), true)

  const forgedRecord = record(paths, {
    owner: 'solo',
    pid: 1,
    result: 'unsent',
    evidence: 'another process claims the same token',
    now: t0 + 2,
  })
  assert.notEqual(forgedRecord.status, 0)
  assert.equal(forgedRecord.stderr.includes('no attempt lock is held by this owner process'), true)
  assert.equal(status(paths, { now: t0 + 3 }).attempts, 0)
})

test('re-enqueue cannot extend the deadline or alter the bound identity', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const extended = invoke(enqueueArgs(paths, [], { deliveryDeadline: ts(7_200_000) }))
  assert.notEqual(extended.status, 0)
  assert.equal(extended.stderr.includes('already exists with a different identity'), true)
  const record = JSON.parse(readFileSync(paths.state, 'utf8'))
  assert.equal(record.delivery_deadline, paths.deliveryDeadline)
})

test('restart resume keeps attempts, deadlines, and next-eligible times intact', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'session-1', now: t0 }).status, 0)
  assert.equal(record(paths, {
    owner: 'session-1',
    result: 'unsent',
    evidence: 'focus conflict',
    now: t0 + 100,
  }).status, 0)
  assert.equal(begin(paths, { owner: 'session-1', verifiedAt: t0 + 1100, now: t0 + 1100 }).status, 0)
  assert.equal(record(paths, {
    owner: 'session-1',
    result: 'unsent',
    evidence: 'focus conflict again',
    now: t0 + 1150,
  }).status, 0)

  const onDiskBefore = readFileSync(paths.state, 'utf8')
  const afterRestart = status(paths, { now: t0 + 1200 })
  assert.equal(afterRestart.attempts, 2)
  assert.equal(afterRestart.delivery_deadline, paths.deliveryDeadline)
  assert.equal(afterRestart.next_eligible_at, ts(3150))

  const newSessionTooEarly = begin(paths, { owner: 'session-2', verifiedAt: t0 + 1200, now: t0 + 1200 })
  assert.notEqual(newSessionTooEarly.status, 0)
  assert.equal(readFileSync(paths.state, 'utf8'), onDiskBefore)

  const eligible = begin(paths, { owner: 'session-2', verifiedAt: t0 + 5150, now: t0 + 5150 })
  assert.equal(eligible.status, 0, eligible.stderr)
})

test('expired deadlines, cancellation, and coordinator handling stop re-delivery with retained reasons', (t) => {
  const expired = fixture(t)
  enqueue(t, expired)
  const afterDeadline = begin(expired, {
    owner: 'worker-a',
    verifiedAt: ts(3_600_000),
    now: ts(3_600_001),
  })
  assert.notEqual(afterDeadline.status, 0)
  assert.equal(afterDeadline.stderr.includes('delivery deadline has passed'), true)
  const expiredShown = status(expired, { now: ts(3_600_002) })
  assert.equal(expiredShown.state, 'stopped')
  assert.equal(expiredShown.last_error.reason, 'delivery_deadline_expired')

  const cancelled = fixture(t)
  enqueue(t, cancelled)
  const stop = invoke([
    script.pathname, 'record-stop',
    '--state', cancelled.state,
    '--reason', 'run_cancelled',
    '--evidence', 'tombstone observed for the run',
    '--now', String(t0 + 10),
  ])
  assert.equal(stop.status, 0, stop.stderr)
  assert.equal(status(cancelled, { now: t0 + 20 }).state, 'stopped')
  assert.equal(begin(cancelled, { owner: 'worker-a', verifiedAt: t0 + 30, now: t0 + 30 }).status !== 0, true)

  const handled = fixture(t)
  enqueue(t, handled)
  assert.equal(begin(handled, { owner: 'worker-a', now: t0 }).status, 0)
  assert.equal(invoke([
    script.pathname, 'record-stop',
    '--state', handled.state,
    '--reason', 'coordinator_handled',
    '--evidence', 'outstanding dispatch advanced past this delivery',
    '--now', String(t0 + 10),
  ]).status, 0)
  const handledShown = status(handled, { now: t0 + 20 })
  assert.equal(handledShown.state, 'stopped')
  assert.equal(handledShown.recommended_action, 'none_stopped')
  assert.equal(record(handled, {
    owner: 'worker-a',
    result: 'confirmed',
    evidence: 'stale owner tries to confirm after stop',
    now: t0 + 30,
  }).status !== 0, true)
})

test('corrupt or tampered pending records fail closed instead of sending', (t) => {
  const corrupt = fixture(t)
  enqueue(t, corrupt)
  writeFileSync(corrupt.state, 'this is not json\n')
  const badStatus = invoke([script.pathname, 'status', '--state', corrupt.state])
  assert.notEqual(badStatus.status, 0)
  assert.equal(badStatus.stderr.includes('not valid JSON'), true)
  const badBegin = begin(corrupt, { owner: 'worker-a', now: t0 })
  assert.notEqual(badBegin.status, 0)

  const tampered = fixture(t)
  enqueue(t, tampered)
  const pending = JSON.parse(readFileSync(tampered.state, 'utf8'))
  pending.state = 'a-state-that-never-existed'
  writeFileSync(tampered.state, `${JSON.stringify(pending)}\n`)
  const badState = invoke([script.pathname, 'status', '--state', tampered.state])
  assert.notEqual(badState.status, 0)
  assert.equal(badState.stderr.includes('unknown delivery state'), true)

  const linked = fixture(t)
  enqueue(t, linked)
  rmSync(linked.state)
  symlinkSync(join(linked.root, 'elsewhere.json'), linked.state)
  const linkedStatus = invoke([script.pathname, 'status', '--state', linked.state])
  assert.notEqual(linkedStatus.status, 0)
  assert.equal(linkedStatus.stderr.includes('must be a regular file'), true)

  const missing = fixture(t)
  const missingStatus = invoke([script.pathname, 'status', '--state', missing.state])
  assert.notEqual(missingStatus.status, 0)
  assert.equal(missingStatus.stderr.includes('no pending delivery record'), true)
})

test('release-attempt returns the delivery to backoff without consuming the send budget', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'worker-a', now: t0 }).status, 0)
  const released = invoke([
    script.pathname, 'release-attempt',
    '--state', paths.state,
    '--owner', 'worker-a',
    '--reason', 'worker must stop before any UI action',
    '--now', String(t0 + 10),
  ])
  assert.equal(released.status, 0, released.stderr)
  const shown = status(paths, { now: t0 + 20 })
  assert.equal(shown.state, 'waiting_backoff')
  assert.equal(shown.attempts, 0)
  assert.equal(existsSync(paths.lock), false)
})

test('render-message reproduces the exact canonical four-line callback with no drift', (t) => {
  for (const outcome of ['completed', 'blocked', 'needs_decision']) {
    const paths = fixture(t, { outcome })
    enqueue(t, paths)
    const rendered = invoke([script.pathname, 'render-message', '--state', paths.state])
    assert.equal(rendered.status, 0, rendered.stderr)
    assert.equal(JSON.parse(rendered.stdout).message_text, expectedMessage(outcome))
  }
})

test('legacy receipt helper files and their tests remain byte-identical to the frozen baseline', () => {
  assert.equal(
    sha256(legacyScript.pathname),
    '645b3622dc78532c0cf13e1495aa1671df624230267f6fc9a9f64c08d777ea09',
  )
  assert.equal(
    sha256(legacyTests.pathname),
    'dabbb28f35ae65eafb39b8412bce2d0448472e442266a8985141c307b2794ef4',
  )
})

test('authority: begin-attempt refuses when the ledger shows the coordinator handled this dispatch', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const ledger = JSON.parse(readFileSync(join(paths.root, 'zcode-runs', `${runId}.json`), 'utf8'))
  ledger.status = 'complete'
  ledger.outstanding_dispatch_id = null
  ledger.handled_dispatch_ids = [dispatchId]
  writeFileSync(join(paths.root, 'zcode-runs', `${runId}.json`), `${JSON.stringify(ledger)}\n`)

  const result = begin(paths, { owner: 'worker-a', verifiedAt: t0, now: t0 })
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('no longer outstanding'), true)
  assert.equal(status(paths, { now: t0 }).state, 'queued')
})

test('authority: begin-attempt refuses when the outstanding dispatch advanced to another dispatch', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const ledger = JSON.parse(readFileSync(join(paths.root, 'zcode-runs', `${runId}.json`), 'utf8'))
  ledger.outstanding_dispatch_id = '33333333-3333-4333-8333-333333333333'
  ledger.handled_dispatch_ids = [dispatchId]
  writeFileSync(join(paths.root, 'zcode-runs', `${runId}.json`), `${JSON.stringify(ledger)}\n`)

  const result = begin(paths, { owner: 'worker-a', verifiedAt: t0, now: t0 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no longer outstanding|already handled|advanced/)
})

test('authority: begin-attempt refuses when the run is cancelled by a tombstone', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  writeFileSync(join(paths.root, 'zcode-runs', `${runId}.tombstone`), '{}\n')

  const result = begin(paths, { owner: 'worker-a', verifiedAt: t0, now: t0 })
  assert.notEqual(result.status, 0)
  assert.equal(result.stderr.includes('cancelled'), true)
})

test('authority: enqueue refuses a run that is already cancelled or handled', (t) => {
  const cancelled = fixture(t)
  writeFileSync(join(cancelled.root, 'zcode-runs', `${runId}.tombstone`), '{}\n')
  const cancelledResult = invoke(enqueueArgs(cancelled))
  assert.notEqual(cancelledResult.status, 0)
  assert.equal(cancelledResult.stderr.includes('cancelled'), true)

  const handled = fixture(t)
  const ledger = JSON.parse(readFileSync(join(handled.root, 'zcode-runs', `${runId}.json`), 'utf8'))
  ledger.status = 'complete'
  ledger.outstanding_dispatch_id = null
  ledger.handled_dispatch_ids = [dispatchId]
  writeFileSync(join(handled.root, 'zcode-runs', `${runId}.json`), `${JSON.stringify(ledger)}\n`)
  const handledResult = invoke(enqueueArgs(handled))
  assert.notEqual(handledResult.status, 0)
  assert.equal(handledResult.stderr.includes('no longer outstanding'), true)
})

test('authority: begin-attempt refuses when the released receipt is no longer a valid terminal receipt', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  writeFileSync(paths.receiptPath, `${JSON.stringify({ status: 'abandoned' })}\n`)

  const result = begin(paths, { owner: 'worker-a', verifiedAt: t0, now: t0 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /receipt|released/)
})

test('authority: every reader fails closed on a pending record whose identity drifted', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const pending = JSON.parse(readFileSync(paths.state, 'utf8'))
  pending.message.message_type = 'blocked'
  pending.envelope.coordinator_task_id = '55555555-5555-4555-8555-555555555555'
  writeFileSync(paths.state, `${JSON.stringify(pending)}\n`)

  assert.notEqual(begin(paths, { owner: 'worker-a', verifiedAt: t0, now: t0 }).status, 0)
  assert.match(invoke([script.pathname, 'status', '--state', paths.state]).stderr, /failed schema validation|receipt/)
  assert.notEqual(invoke([script.pathname, 'render-message', '--state', paths.state]).status, 0)
})

test('authority: a pending record with impossible counters or inconsistent instants fails closed', (t) => {
  for (const mutate of [
    (pending) => { pending.attempts = -100 },
    (pending) => { pending.attempts_started = -5 },
    (pending) => { pending.delivery_deadline_ms = Date.parse(pending.delivery_deadline) + 86_400_000 },
    (pending) => { pending.next_eligible_ms = 0 },
    (pending) => { pending.policy.max_attempts = 0 },
    (pending) => { pending.policy.backoff_cap_ms = pending.policy.backoff_base_ms - 1 },
    (pending) => { delete pending.generation },
  ]) {
    const paths = fixture(t)
    enqueue(t, paths)
    const pending = JSON.parse(readFileSync(paths.state, 'utf8'))
    mutate(pending)
    writeFileSync(paths.state, `${JSON.stringify(pending)}\n`)
    const result = begin(paths, { owner: 'worker-a', verifiedAt: t0, now: t0 })
    assert.notEqual(result.status, 0, JSON.stringify(pending.attempts))
    assert.match(result.stderr, /failed schema validation/)
  }
})

test('confirmation contract: record-result confirmed requires the exact single observed message', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'worker-a', now: t0 }).status, 0)

  const missing = record(paths, {
    owner: 'worker-a',
    result: 'confirmed',
    evidence: 'claims success without the observed message',
    now: t0 + 10,
  })
  assert.notEqual(missing.status, 0)
  assert.equal(missing.stderr.includes('observed-message'), true)

  const tailOnly = record(paths, {
    owner: 'worker-a',
    result: 'confirmed',
    evidence: 'only the identifier lines arrived; first line was a separate earlier message',
    observedMessage: 'message_type: completed\nrun_id: ' + runId + '\ndispatch_id: ' + dispatchId,
    now: t0 + 20,
  })
  assert.notEqual(tailOnly.status, 0)
  assert.equal(status(paths, { now: t0 + 30 }).state, 'in_attempt')

  const whole = record(paths, {
    owner: 'worker-a',
    result: 'confirmed',
    evidence: 're-read shows the complete four-line message within one user message',
    observedMessage: expectedMessage(paths.outcome),
    now: t0 + 40,
  })
  assert.equal(whole.status, 0, whole.stderr)
  assert.equal(status(paths, { now: t0 + 50 }).state, 'confirmed')
})

test('concurrency: racing record-stop writers produce exactly one retained reason and no lost update', async (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const results = await Promise.all(['run_cancelled', 'coordinator_handled', 'target_mismatch', 'run_cancelled', 'coordinator_handled', 'target_mismatch'].map((reason, index) =>
    new Promise((resolveResult) => {
      const child = spawn(process.execPath, [
        script.pathname, 'record-stop',
        '--state', paths.state,
        '--reason', reason,
        '--evidence', `racing stopper ${index}`,
        '--now', String(t0 + index),
      ])
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.on('close', status => resolveResult({ status, stderr }))
    })))

  const succeeded = results.filter(r => r.status === 0)
  assert.equal(succeeded.length === results.length, false)
  const pending = JSON.parse(readFileSync(paths.state, 'utf8'))
  assert.equal(pending.state, 'stopped')
  assert.equal(pending.history.filter(h => h.event === 'stop').length, 1)
})

test('concurrency: racing enqueues of the same identity create exactly one record', async (t) => {
  const paths = fixture(t)
  const results = await Promise.all([1, 2, 3, 4].map(() =>
    new Promise((resolveResult) => {
      const child = spawn(process.execPath, enqueueArgs(paths))
      let stdout = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.on('close', status => resolveResult({ status, stdout }))
    })))

  const ok = results.filter(r => r.status === 0)
  assert.equal(ok.length, results.length)
  assert.equal(ok.filter(r => JSON.parse(r.stdout).created === true).length, 1)
})

test('authority death mid-attempt stops the record; transient ledger errors do not', (t) => {
  const definitive = fixture(t)
  enqueue(t, definitive)
  assert.equal(begin(definitive, { owner: 'worker-a', now: t0 }).status, 0)
  const ledger = JSON.parse(readFileSync(join(definitive.root, 'zcode-runs', `${runId}.json`), 'utf8'))
  ledger.status = 'complete'
  ledger.outstanding_dispatch_id = null
  ledger.handled_dispatch_ids = [dispatchId]
  writeFileSync(join(definitive.root, 'zcode-runs', `${runId}.json`), `${JSON.stringify(ledger)}\n`)
  const stopped = record(definitive, {
    owner: 'worker-a',
    result: 'unsent',
    evidence: 'worker observes coordinator took over mid-attempt',
    now: t0 + 10,
  })
  assert.notEqual(stopped.status, 0)
  const stoppedState = status(definitive, { now: t0 + 20 })
  assert.equal(stoppedState.state, 'stopped')
  assert.match(JSON.stringify(stoppedState.last_error), /coordinator_handled/)

  const transient = fixture(t)
  enqueue(t, transient)
  assert.equal(begin(transient, { owner: 'worker-b', now: t0 }).status, 0)
  rmSync(join(transient.root, 'zcode-runs', `${runId}.json`))
  const failed = record(transient, {
    owner: 'worker-b',
    result: 'unsent',
    evidence: 'ledger unreadable this instant',
    now: t0 + 10,
  })
  assert.notEqual(failed.status, 0)
  assert.equal(status(transient, { now: t0 + 20 }).state, 'in_attempt')
})

test('verify: orphan lock on needs_verification is discarded with dead-pid proof', async (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const doomed = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  const deadPid = doomed.pid
  doomed.kill('SIGKILL')
  await new Promise(resolve => doomed.on('close', resolve))

  assert.equal(begin(paths, { owner: 'crashed', pid: deadPid, now: t0 }).status, 0)
  assert.equal(record(paths, {
    owner: 'crashed',
    pid: deadPid,
    result: 'sent_unconfirmed',
    evidence: 'sent then crashed before the outcome was recorded',
    now: t0 + 100,
  }).status, 0)
  // simulate the crash window: the attempt lock file outlived its dead owner
  writeFileSync(paths.lock, `${JSON.stringify({
    protocol: 'zcode-callback-delivery/v1',
    delivery_id: `${runId}.${dispatchId}`,
    owner: 'crashed',
    pid: deadPid,
    acquired_at: ts(0),
    lease_expires_at: ts(120_000),
  })}\n`)

  const verified = invoke([
    script.pathname, 'verify',
    '--state', paths.state,
    '--owner', 'continuation',
    '--owner-pid', String(process.pid),
    '--found', 'true',
    '--evidence', 're-read shows the complete four-line message in one message',
    '--observed-message', expectedMessage(paths.outcome),
    '--target-verified-at', String(t0 + 200),
    '--now', String(t0 + 200),
  ])
  rmSync(paths.lock, { recursive: true, force: true })
  assert.equal(verified.status, 0, verified.stderr)
  assert.equal(status(paths, { now: t0 + 210 }).state, 'confirmed')
})

test('verify requires the owner pid binding', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  assert.equal(begin(paths, { owner: 'worker-a', now: t0 }).status, 0)
  assert.equal(record(paths, {
    owner: 'worker-a',
    result: 'sent_unconfirmed',
    evidence: 'confirmation read lost',
    now: t0 + 100,
  }).status, 0)
  const missing = invoke([
    script.pathname, 'verify',
    '--state', paths.state,
    '--owner', 'worker-b',
    '--found', 'true',
    '--evidence', 'attempt without pid binding',
    '--observed-message', expectedMessage(paths.outcome),
    '--target-verified-at', String(t0 + 200),
    '--now', String(t0 + 200),
  ])
  assert.notEqual(missing.status, 0)
  assert.equal(missing.stderr.includes('owner-pid'), true)
})

test('mutex: a live holder paused in the creation window is never stolen, even after the old grace period', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const stateLock = `${paths.state.replace(/\.pending\.json$/, '')}.state.lock`
  // Simulate a live process suspended between O_EXCL creation and the pid write:
  // the mutex exists, is empty, and an open fd proves the holder is alive.
  const holderFd = openSync(stateLock, constants_O_CREAT | constants_O_TRUNC | constants_O_RDWR, 0o600)
  try {
    const refused = invoke([
      script.pathname, 'record-stop',
      '--state', paths.state,
      '--reason', 'run_cancelled',
      '--evidence', 'competitor while holder is suspended pre-write',
      '--now', String(t0 + 10),
    ])
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /mutex|busy|state/)

    // Long after any legacy grace period, the unknown lock must still exist and stay untouched.
    waitQuiet(200)
    const stillThere = readFileSync(stateLock, 'utf8')
    assert.equal(stillThere, '')
    assert.equal(status(paths, { now: t0 + 20 }).state, 'queued')
  } finally {
    closeSync(holderFd)
    rmSync(stateLock, { force: true })
  }
})

test('mutex: a published lock from a live holder blocks writers and survives untouched', async (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const stateLock = `${paths.state.replace(/\.pending\.json$/, '')}.state.lock`
  const holder = spawn(process.execPath, [
    '-e',
    `const fs = require('fs');
     const tmp = ${JSON.stringify(stateLock)} + '.holder.tmp';
     fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, acquired_at: 'fixture' }));
     fs.linkSync(tmp, ${JSON.stringify(stateLock)});
     fs.unlinkSync(tmp);
     setTimeout(() => {}, 8000);`,
  ])
  t.after(() => { holder.kill('SIGKILL') })
  try {
    await waitFor(() => existsSync(stateLock))
    const before = readFileSync(stateLock, 'utf8')

    const refused = invoke([
      script.pathname, 'record-stop',
      '--state', paths.state,
      '--reason', 'run_cancelled',
      '--evidence', 'competitor against a live published holder',
      '--now', String(t0 + 10),
    ])
    assert.notEqual(refused.status, 0)
    assert.equal(readFileSync(stateLock, 'utf8'), before)
  } finally {
    holder.kill('SIGKILL')
  }
})

test('mutex: a paused publisher that resumes after the lock changed hands never clobbers the new owner', async (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const stateLock = `${paths.state.replace(/\.pending\.json$/, '')}.state.lock`
  const signalFile = join(paths.root, 'resume-a.signal')
  writeFileSync(signalFile, 'hold')
  const aTmp = `${stateLock}.a.tmp`
  let publisherOutcome = ''
  const publisherA = spawn(process.execPath, [
    '-e',
    `const fs = require('fs');
     const lock = ${JSON.stringify(stateLock)};
     const tmp = lock + '.a.tmp';
     fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, acquired_at: 'A' }));
     while (fs.existsSync(${JSON.stringify(signalFile)})) {}
     let outcome = 'error:unknown';
     try {
       fs.linkSync(tmp, lock);
       outcome = 'published';
     } catch (e) {
       if (e.code !== 'EEXIST') {
         outcome = 'error:' + e.code;
       } else {
         let holder = null;
         try { holder = JSON.parse(fs.readFileSync(lock, 'utf8')) } catch {}
         if (holder && process.kill(holder.pid, 0)) {
           outcome = 'busy-live';
         } else {
           try { fs.unlinkSync(lock) } catch {}
           try { fs.linkSync(tmp, lock); outcome = 'published-after-reclaim'; } catch (e2) { outcome = 'error:' + e2.code; }
         }
       }
     }
     console.log(outcome);
     process.exit(outcome === 'busy-live' || outcome === 'published' || outcome === 'published-after-reclaim' ? 0 : 2);`,
  ])
  const holderB = spawn(process.execPath, [
    '-e',
    `const fs = require('fs');
     const tmp = ${JSON.stringify(stateLock)} + '.b.tmp';
     fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, acquired_at: 'B' }));
     fs.linkSync(tmp, ${JSON.stringify(stateLock)});
     fs.unlinkSync(tmp);
     setTimeout(() => {}, 8000);`,
  ])
  publisherA.stdout.setEncoding('utf8').on('data', chunk => { publisherOutcome += chunk })
  t.after(() => { publisherA.kill('SIGKILL'); holderB.kill('SIGKILL') })
  try {
    await waitFor(() => existsSync(stateLock))
    const bContent = readFileSync(stateLock, 'utf8')
    assert.equal(publisherA.exitCode, null)
    await waitFor(() => existsSync(aTmp))

    rmSync(signalFile)
    await exitOf(publisherA, 5000)
    // A must have failed busy against the live B lock, never deleting or replacing it.
    assert.match(publisherOutcome, /busy-live|published/)
    assert.equal(readFileSync(stateLock, 'utf8'), bContent)
  } finally {
    holderB.kill('SIGKILL')
    rmSync(stateLock, { force: true })
  }
})

test('mutex: a provably dead published lock is conservatively refused, never auto-reclaimed', async (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const stateLock = `${paths.state.replace(/\.pending\.json$/, '')}.state.lock`
  const dead = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  const deadPid = dead.pid
  dead.kill('SIGKILL')
  await new Promise(resolve => dead.on('close', resolve))
  writeFileSync(stateLock, `${JSON.stringify({ pid: deadPid, acquired_at: 'fixture-dead' })}\n`)
  const lockBefore = readFileSync(stateLock, 'utf8')

  const result = invoke([
    script.pathname, 'record-stop',
    '--state', paths.state,
    '--reason', 'run_cancelled',
    '--evidence', 'conservative refusal of a dead-pid mutex',
    '--now', String(t0 + 10),
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /mutex/)
  assert.equal(readFileSync(stateLock, 'utf8'), lockBefore)
  const shown = status(paths, { now: t0 + 20 })
  assert.equal(shown.state, 'queued')
})

test('mutex: successful commands leave no mutex or temp debris behind', (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const stateLock = `${paths.state.replace(/\.pending\.json$/, '')}.state.lock`
  const result = invoke([
    script.pathname, 'record-stop',
    '--state', paths.state,
    '--reason', 'run_cancelled',
    '--evidence', 'clean lifecycle check',
    '--now', String(t0 + 10),
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(stateLock), false)
  const leftovers = readdirSync(paths.stateDir).filter(name => name.includes('.state.lock'))
  assert.deepEqual(leftovers, [])
})

test('mutex: two real recoverers racing a dead-pid mutex both refuse and nothing changes', async (t) => {
  const paths = fixture(t)
  enqueue(t, paths)
  const stateLock = `${paths.state.replace(/\.pending\.json$/, '')}.state.lock`
  const dead = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  const deadPid = dead.pid
  dead.kill('SIGKILL')
  await new Promise(resolve => dead.on('close', resolve))
  assert.throws(() => process.kill(deadPid, 0), e => e.code === 'ESRCH')
  writeFileSync(stateLock, `${JSON.stringify({ pid: deadPid, acquired_at: 'fixture-dead' })}\n`)
  const lockBefore = readFileSync(stateLock, 'utf8')
  const stateBefore = readFileSync(paths.state, 'utf8')

  const results = await Promise.all(['first-recoverer', 'second-recoverer'].map(evidence =>
    new Promise(resolve => {
      const child = spawn(process.execPath, [
        script.pathname, 'record-stop',
        '--state', paths.state,
        '--reason', 'run_cancelled',
        '--evidence', evidence,
        '--now', String(t0 + 10),
      ])
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.on('close', status => resolve({ status, stderr }))
    })))

  for (const r of results) {
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /mutex/)
  }
  assert.equal(readFileSync(stateLock, 'utf8'), lockBefore)
  assert.equal(readFileSync(paths.state, 'utf8'), stateBefore)
})
