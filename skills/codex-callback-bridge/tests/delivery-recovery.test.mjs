// DeliveryRecoveryAndDocs: result-first delivery intent tests.
// Covers the release→enqueue crash-window recovery (`recover`), zero-send
// location diagnostics (`note-block`), and a real two-recoverer race.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const candidate = process.env.CANDIDATE_BRIDGE
assert.ok(candidate, 'CANDIDATE_BRIDGE must point at the candidate bridge directory')

const delivery = join(candidate, 'scripts/delivery.mjs')
const receiptScript = join(candidate, 'scripts/receipt.mjs')
const WORK_STOP_AT = '2099-01-01T00:00:00Z'
const DELIVERY_DEADLINE = '2099-06-01T00:00:00Z'

function fixture(outcome = 'completed') {
  const temp = fs.mkdtempSync(join(tmpdir(), 'delivery-recovery-'))
  const state = join(temp, 'zcode-runs')
  fs.mkdirSync(state)
  const deliveries = join(temp, 'codex-callback-deliveries')
  fs.mkdirSync(deliveries)
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
    attempt_limits: { stop_at: WORK_STOP_AT },
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
  const base = [
    '--ledger', ledgerPath,
    '--tombstone', join(state, `${run}.tombstone`),
    '--receiver', receiver,
    '--run-id', run,
    '--dispatch-id', dispatch,
    '--coordinator-task-id', coordinator,
    '--stop-at', WORK_STOP_AT,
  ]
  const invoke = (args, env = {}) => spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
  })
  const recordPath = join(deliveries, `${run}.${dispatch}.pending.json`)
  const recoverArgs = [
    delivery, 'recover',
    '--state-dir', deliveries,
    '--run-id', run,
    '--dispatch-id', dispatch,
    '--coordinator-task-id', coordinator,
    '--codex-project', 'Tasks',
    '--codex-task-title', 'ZCode 回传桥维护',
    '--ledger-path', ledgerPath,
    '--tombstone-path', join(state, `${run}.tombstone`),
    '--receiver-path', receiver,
    '--receipt-dir', receiver,
    '--message-type', outcome,
    '--work-stop-at', WORK_STOP_AT,
  ]
  return {
    temp, state, deliveries, run, dispatch, coordinator, ledger, ledgerPath,
    receiver, recordPath, invoke, base, recoverArgs,
    release() {
      const claim = invoke([receiptScript, 'claim', ...base])
      assert.equal(claim.status, 0, claim.stderr)
      const receiverId = JSON.parse(claim.stdout).receiver_id
      const done = invoke([receiptScript, 'release', ...base, '--receiver-id', receiverId, '--outcome', outcome])
      assert.equal(done.status, 0, done.stderr)
      return receiverId
    },
    recover(extra = []) {
      return invoke([...recoverArgs, '--delivery-deadline', DELIVERY_DEADLINE, ...extra])
    },
  }
}

test('recover backfills the pending record once after a release→enqueue crash window', () => {
  const f = fixture()
  const receiverId = f.release()
  const receiptBytes = fs.readFileSync(join(f.receiver, 'receipt.json'))
  assert.equal(fs.existsSync(f.recordPath), false, 'crash window: no pending record exists yet')
  const first = f.recover()
  assert.equal(first.status, 0, first.stderr)
  const parsed = JSON.parse(first.stdout)
  assert.equal(parsed.created, true)
  assert.equal(parsed.state, 'queued')
  assert.equal(fs.readFileSync(join(f.receiver, 'receipt.json')).compare(receiptBytes), 0,
    'recovery must never touch the terminal receipt')
  assert.equal(JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')).status, 'dispatched',
    'recovery must not consume or rerun anything')
  const second = f.recover()
  assert.equal(second.status, 0, second.stderr)
  assert.equal(JSON.parse(second.stdout).created, false, 'recovery must be idempotent for identical identity')
  const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'))
  assert.equal(record.envelope.run_id, f.run)
  assert.equal(record.receipt.receiver_id, receiverId)
  assert.equal(record.delivery_deadline, DELIVERY_DEADLINE)
  assert.ok(record.history.some(entry => entry.event === 'recover'), 'recovery must be audited in history')
})

test('recover refuses an explicit deadline absence, tampered identities, and consumed or cancelled runs', () => {
  const f = fixture()
  f.release()
  const noDeadline = f.invoke(f.recoverArgs)
  assert.notEqual(noDeadline.status, 0, 'recovery must not invent a delivery deadline')
  assert.match(noDeadline.stderr, /delivery deadline must be explicitly authorized/)

  const again = f.recover()
  assert.equal(again.status, 0, again.stderr)
  const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'))
  const differentDeadline = f.recover(['--delivery-deadline', '2099-12-01T00:00:00Z'])
  assert.notEqual(differentDeadline.status, 0, 'an existing pending record must not be re-deadlined')
  assert.equal(JSON.parse(fs.readFileSync(f.recordPath, 'utf8')).delivery_deadline, record.delivery_deadline)

  const handled = fixture()
  handled.release()
  assert.equal(handled.recover().status, 0)
  const ledger = JSON.parse(fs.readFileSync(handled.ledgerPath, 'utf8'))
  ledger.handled_dispatch_ids.push(handled.dispatch)
  fs.writeFileSync(handled.ledgerPath, JSON.stringify(ledger))
  const replay = handled.recover()
  assert.notEqual(replay.status, 0, 'a handled dispatch must not be recovered into a new sendable record')
  assert.match(replay.stderr, /no longer outstanding/)

  const cancelled = fixture()
  cancelled.release()
  fs.writeFileSync(join(cancelled.state, `${cancelled.run}.tombstone`), 'stopped')
  const revived = cancelled.recover()
  assert.notEqual(revived.status, 0, 'a cancelled run must never be recovered')
  assert.match(revived.stderr, /cancelled/)

  const wrong = fixture()
  wrong.release()
  const wrongCoordinator = wrong.invoke(
    [...wrong.recoverArgs, '--delivery-deadline', DELIVERY_DEADLINE].map(a => a === wrong.coordinator ? randomUUID() : a),
  )
  assert.notEqual(wrongCoordinator.status, 0, 'wrong coordinator identity must be refused')
  assert.match(wrongCoordinator.stderr, /released receipt identity mismatch|coordinator/)
})

test('note-block persists zero-send location diagnostics and is bounded', () => {
  const f = fixture()
  f.release()
  assert.equal(f.recover().status, 0)
  const note = reason => f.invoke([
    delivery, 'note-block',
    '--state', f.recordPath,
    '--reason', reason,
    '--evidence', `anchor not located in ${reason} observation`,
  ])
  for (let index = 0; index < 8; index += 1) {
    const result = note('anchor_not_found')
    assert.equal(result.status, 0, result.stderr)
    if (index < 7) {
      const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'))
      assert.equal(record.state, 'queued', 'blocks must not terminate the record before the cap')
    }
  }
  const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'))
  assert.equal(record.state, 'stopped', 'location failures must be bounded, not an infinite zero-send loop')
  assert.equal(record.last_error.reason, 'location_budget_exhausted')
  assert.equal(record.attempts, 0, 'zero sends must have happened')
  const blockEvents = record.history.filter(entry => entry.event === 'location_blocked')
  assert.ok(blockEvents.length >= 8, 'every blocked observation must be explainable')
  const begin = f.invoke([
    delivery, 'begin-attempt',
    '--state', f.recordPath,
    '--owner', 'x',
    '--owner-pid', '1',
    '--target-verified-at', new Date().toISOString(),
  ])
  assert.notEqual(begin.status, 0, 'a stopped record must not begin attempts')
})

test('the durable location budget cannot be dodged by reason rotation, survives restarts, and honors the deadline', () => {
  const f = fixture()
  f.release()
  assert.equal(f.recover().status, 0)
  const note = (reason, extra = []) => f.invoke([
    delivery, 'note-block',
    '--state', f.recordPath,
    '--reason', reason,
    '--evidence', 'rotation probe observation',
    ...extra,
  ])
  for (let index = 0; index < 80; index += 1) {
    const result = note('reason_' + (index % 8))
    assert.equal(result.status, 0, result.stderr)
  }
  const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'))
  assert.equal(record.state, 'stopped', 'rotating reasons must not dodge the durable budget')
  assert.equal(record.last_error.reason, 'location_budget_exhausted')
  assert.equal(record.attempts, 0)
  assert.ok(record.location_blocks_total >= 8, 'the durable counter must persist')

  const late = fixture()
  late.release()
  assert.equal(late.recover().status, 0)
  const pastDeadline = late.invoke([
    delivery, 'note-block',
    '--state', late.recordPath,
    '--reason', 'anchor_not_found',
    '--evidence', 'observed after the delivery deadline',
    '--now', String(Date.parse(DELIVERY_DEADLINE) + 1),
  ])
  assert.equal(pastDeadline.status, 0, pastDeadline.stderr)
  const lateRecord = JSON.parse(fs.readFileSync(late.recordPath, 'utf8'))
  assert.equal(lateRecord.state, 'stopped')
  assert.equal(lateRecord.last_error.reason, 'delivery_deadline_expired')
})

test('note-block never overwrites live attempts, unresolved uncertainty, or foreign locks', () => {
  const f = fixture()
  f.release()
  assert.equal(f.recover().status, 0)
  const owner = randomUUID()
  const noteArgs = [
    delivery, 'note-block',
    '--state', f.recordPath,
    '--reason', 'anchor_not_found',
    '--evidence', 'must be a no-op here',
  ]
  const attemptLock = join(f.deliveries, `${f.run}.${f.dispatch}.attempt.lock`)
  const begin = f.invoke([
    delivery, 'begin-attempt',
    '--state', f.recordPath,
    '--owner', owner,
    '--owner-pid', String(process.pid),
    '--target-verified-at', String(Date.now()),
    '--now', String(Date.now()),
  ])
  assert.equal(begin.status, 0, begin.stderr)
  const ignoredLive = f.invoke(noteArgs)
  assert.equal(ignoredLive.status, 0, 'diagnostics must be accepted as no-ops on a live attempt')
  const liveRecord = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'))
  assert.equal(liveRecord.state, 'in_attempt', 'a live attempt must not be overwritten')
  assert.equal(liveRecord.owner, owner, 'the live owner must be preserved')
  assert.ok(fs.existsSync(attemptLock), 'the attempt lock must remain untouched')

  const uncertain = fixture()
  uncertain.release()
  assert.equal(uncertain.recover().status, 0)
  const uncertainOwner = randomUUID()
  assert.equal(uncertain.invoke([
    delivery, 'begin-attempt',
    '--state', uncertain.recordPath,
    '--owner', uncertainOwner,
    '--owner-pid', String(process.pid),
    '--target-verified-at', String(Date.now()),
    '--now', String(Date.now()),
  ]).status, 0)
  assert.equal(uncertain.invoke([
    delivery, 'record-result',
    '--state', uncertain.recordPath,
    '--owner', uncertainOwner,
    '--owner-pid', String(process.pid),
    '--result', 'sent_unconfirmed',
    '--evidence', 'simulated send uncertainty',
  ]).status, 0)
  const uncertainNote = f.invoke([
    delivery, 'note-block',
    '--state', uncertain.recordPath,
    '--reason', 'anchor_not_found',
    '--evidence', 'must be a no-op here',
  ])
  assert.equal(uncertainNote.status, 0)
  const uncertainRecord = JSON.parse(fs.readFileSync(uncertain.recordPath, 'utf8'))
  assert.equal(uncertainRecord.state, 'needs_verification', 'unresolved uncertainty must not become a location stop')
  assert.equal(uncertainRecord.attempts, 1, 'the real send count must be preserved')
})

test('recover without an authorized deadline persists its refusal as durable evidence', () => {
  const f = fixture()
  f.release()
  const refused = f.invoke(f.recoverArgs)
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /delivery deadline must be explicitly authorized/)
  const sidecar = join(f.deliveries, `${f.run}.${f.dispatch}.recovery-blocked.json`)
  assert.ok(fs.existsSync(sidecar), 'the refusal reason must be persisted, not only printed')
  const note = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  assert.equal(note.status, 'recovery_blocked')
  assert.match(note.reason, /explicitly authorized/)
  assert.equal(fs.existsSync(f.recordPath), false, 'no sendable record may be created without authorization')
})

test('recover refuses active receipts, expired deadlines, and stale dispatches with a valid deadline present', () => {
  const active = fixture()
  active.release()
  const receiptPath = join(active.receiver, 'receipt.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.status = 'active'
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  const activeRecovery = active.recover()
  assert.notEqual(activeRecovery.status, 0, 'an active receipt must never be recovered')
  assert.match(activeRecovery.stderr, /not a released terminal receipt/)

  const expired = fixture()
  expired.release()
  const expiredRecovery = expired.invoke([...expired.recoverArgs, '--delivery-deadline', '2026-01-01T00:00:00Z'])
  assert.notEqual(expiredRecovery.status, 0, 'an expired delivery deadline must be refused')
  assert.match(expiredRecovery.stderr, /delivery deadline has already passed/)

  const stale = fixture()
  stale.release()
  const ledger = JSON.parse(fs.readFileSync(stale.ledgerPath, 'utf8'))
  ledger.outstanding_dispatch_id = randomUUID()
  fs.writeFileSync(stale.ledgerPath, JSON.stringify(ledger))
  const staleRecovery = stale.recover()
  assert.notEqual(staleRecovery.status, 0, 'a stale dispatch must not be recovered')
  assert.match(staleRecovery.stderr, /no longer outstanding/)
})

test('the budget field is schema-validated and legacy records stop at an explainable checkpoint', () => {
  for (const bad of [-1, 'bad', 1.5]) {
    const f = fixture()
    f.release()
    assert.equal(f.recover().status, 0)
    const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'))
    assert.equal(record.record_version, 2, 'new records must carry the budget record version')
    record.location_blocks_total = bad
    fs.writeFileSync(f.recordPath, JSON.stringify(record))
    const before = fs.readFileSync(f.recordPath, 'utf8')
    const status = f.invoke([delivery, 'status', '--state', f.recordPath])
    assert.notEqual(status.status, 0, `corrupt counter ${JSON.stringify(bad)} must fail schema validation`)
    const note = f.invoke([delivery, 'note-block', '--state', f.recordPath, '--reason', 'anchor_not_found', '--evidence', 'corruption fixture'])
    assert.notEqual(note.status, 0, `corrupt counter ${JSON.stringify(bad)} must not be silently repaired`)
    assert.equal(fs.readFileSync(f.recordPath, 'utf8'), before, 'refused reads and notes must preserve bytes')
  }

  const deleted = fixture()
  deleted.release()
  assert.equal(deleted.recover().status, 0)
  const dr = JSON.parse(fs.readFileSync(deleted.recordPath, 'utf8'))
  delete dr.location_blocks_total
  fs.writeFileSync(deleted.recordPath, JSON.stringify(dr))
  const dBefore = fs.readFileSync(deleted.recordPath, 'utf8')
  assert.notEqual(deleted.invoke([delivery, 'status', '--state', deleted.recordPath]).status, 0,
    'deleting the field from a versioned record must not restore budget')
  assert.equal(fs.readFileSync(deleted.recordPath, 'utf8'), dBefore)

  const over = fixture()
  over.release()
  assert.equal(over.recover().status, 0)
  const or = JSON.parse(fs.readFileSync(over.recordPath, 'utf8'))
  or.location_blocks_total = 1000001
  fs.writeFileSync(over.recordPath, JSON.stringify(or))
  assert.notEqual(over.invoke([delivery, 'status', '--state', over.recordPath]).status, 0,
    'the counter must have a documented upper bound')

  const legacy = fixture()
  legacy.release()
  assert.equal(legacy.recover().status, 0)
  const lr = JSON.parse(fs.readFileSync(legacy.recordPath, 'utf8'))
  delete lr.record_version
  delete lr.location_blocks_total
  fs.writeFileSync(legacy.recordPath, JSON.stringify(lr))
  const legacyNote = legacy.invoke([delivery, 'note-block', '--state', legacy.recordPath, '--reason', 'anchor_not_found', '--evidence', 'first observation after upgrade'])
  assert.equal(legacyNote.status, 0, legacyNote.stderr)
  const legacyAfter = JSON.parse(fs.readFileSync(legacy.recordPath, 'utf8'))
  assert.equal(legacyAfter.state, 'stopped', 'unprovable legacy history must stop at a conservative checkpoint')
  assert.equal(legacyAfter.last_error.reason, 'legacy_location_budget_unknown')
  assert.equal(legacyAfter.location_blocks_total, undefined, 'no budget may be invented for legacy records')
  const legacyReplay = legacy.invoke([delivery, 'note-block', '--state', legacy.recordPath, '--reason', 'anchor_not_found', '--evidence', 'no-op on terminal'])
  assert.equal(legacyReplay.status, 0)
  assert.equal(JSON.parse(fs.readFileSync(legacy.recordPath, 'utf8')).state, 'stopped')
})

test('two real recoverers race through a ready/go barrier and create exactly one record', async () => {
  const f = fixture()
  f.release()
  const go = join(f.temp, 'go')
  const readyA = join(f.temp, 'ready-a')
  const readyB = join(f.temp, 'ready-b')
  const child = (ready, id) => {
    const script = 'const{spawnSync}=require("node:child_process");const fs=require("node:fs");' +
      `fs.writeFileSync(${JSON.stringify(ready)}, "ready");` +
      `while(!fs.existsSync(${JSON.stringify(go)}));` +
      `const r=spawnSync(process.execPath,${JSON.stringify(f.recoverArgs.concat(['--delivery-deadline', DELIVERY_DEADLINE]))},{encoding:"utf8"});` +
      `fs.appendFileSync(${JSON.stringify(join(f.temp, 'out.jsonl'))}, JSON.stringify({id:${JSON.stringify(id)},status:r.status,out:r.stdout.trim()})+"\\n");` +
      'process.exit(r.status === null ? 1 : r.status)'
    return spawn(process.execPath, ['-e', script])
  }
  const children = [child(readyA, 'a'), child(readyB, 'b')]
  const deadline = Date.now() + 15000
  while ((!fs.existsSync(readyA) || !fs.existsSync(readyB)) && Date.now() < deadline) {
    await new Promise(resolveChild => setTimeout(resolveChild, 10))
  }
  assert.ok(fs.existsSync(readyA) && fs.existsSync(readyB), 'both recoverers must be ready before the barrier opens')
  fs.writeFileSync(go, 'go')
  await Promise.all(children.map(proc => new Promise(resolveChild => proc.on('close', resolveChild))))
  const outs = fs.readFileSync(join(f.temp, 'out.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(outs.length, 2)
  const created = outs.filter(entry => JSON.parse(entry.out).created === true)
  assert.equal(created.length, 1, 'exactly one recoverer may create the record')
  const record = JSON.parse(fs.readFileSync(f.recordPath, 'utf8'))
  assert.equal(record.state, 'queued')
  assert.deepEqual(record.envelope.run_id ? [record.envelope.run_id] : [], [f.run])
})
