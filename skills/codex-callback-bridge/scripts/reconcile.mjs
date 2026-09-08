#!/usr/bin/env node

// Coordinator-side receipt reconciliation fallback (CallbackStabilityRecovery).
// Consumes a released receipt for the current outstanding dispatch into the
// existing coordinator state machine without faking UI delivery, without
// renewing dispatches, and without a second weakened lock protocol: the lock,
// CAS and durability rules mirror scripts/receipt.mjs and the trusted
// coordinator entry (mkdir lock + holder.json O_EXCL + fsync + revision CAS).
//
// reconcile: released receipt -> reviewing (completed) with retained holder.
// holder:    read-only resume route printing the retained review holder.

import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

const RECEIPT_PROTOCOL = 'zcode-callback-receipt/v1'
const MAX_LEDGER_BYTES = 1024 * 1024
const MAX_RECEIPT_BYTES = 64 * 1024
const OUTCOMES = new Set(['completed', 'blocked', 'needs_decision'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Codex issues coordinator task ids as RFC 9562 UUIDv7; run and dispatch ids
// are coordinator-generated v4 and keep their stricter validation.
const CODEX_TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const [command, ...tokens] = argv
  if (!['reconcile', 'holder'].includes(command)) {
    fail('usage: reconcile.mjs <reconcile|holder> --ledger PATH --run-id ID --dispatch-id ID --coordinator-task-id ID --expected-revision N')
  }
  const options = {}
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index]
    const value = tokens[index + 1]
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`invalid argument near ${flag ?? '<end>'}`)
    }
    const key = flag.slice(2)
    if (options[key] !== undefined) fail(`duplicate argument --${key}`)
    options[key] = value
  }
  const allowed = new Set(['ledger', 'run-id', 'dispatch-id', 'coordinator-task-id', 'expected-revision'])
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail(`unknown argument --${key}`)
  }
  for (const key of ['ledger', 'run-id', 'dispatch-id', 'coordinator-task-id', 'expected-revision']) {
    if (!options[key]) fail(`missing required argument --${key}`)
  }
  const expectedRevision = Number(options['expected-revision'])
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail('expected-revision must be a non-negative safe integer')
  }
  return { command, options, expectedRevision }
}

function validatePaths(options) {
  const ledger = options.ledger
  if (!isAbsolute(ledger) || resolve(ledger) !== ledger) {
    fail('ledger path must be absolute and normalized')
  }
  const runId = options['run-id']
  const dispatchId = options['dispatch-id']
  const coordinatorTaskId = options['coordinator-task-id']
  if (!UUID.test(runId)) fail('run-id must be a lowercase UUID')
  if (!UUID.test(dispatchId)) fail('dispatch-id must be a lowercase UUID')
  if (!CODEX_TASK_ID.test(coordinatorTaskId)) fail('coordinator-task-id must be a lowercase UUID (versions 1-8)')
  if (basename(ledger) !== `${runId}.json`) fail('ledger path does not match run ID')
  const stateDir = dirname(ledger)
  if (basename(stateDir) !== 'zcode-runs') fail('ledger must live in a zcode-runs directory')
  const stateStat = lstatSync(stateDir)
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    fail('state directory must be a real directory')
  }
  // Canonical receiver path only: the receipt must live where the trusted
  // receipt helper would have created it for this run and dispatch.
  const receiver = `${stateDir}/${runId}.${dispatchId}.receiver`
  return { ledger, stateDir, runId, dispatchId, coordinatorTaskId, expectedRevision: options.expectedRevision, receiver, tombstone: `${stateDir}/${runId}.tombstone`, lock: `${stateDir}/${runId}.lock` }
}

function entryExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function readJsonFile(path, label, maxBytes) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`)
  if (stat.size > maxBytes) fail(`${label} is too large`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`${label} is not valid JSON`)
  }
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function atomicWriteJson(directory, target, value, onRenamed) {
  const temporary = `${directory}/.reconcile.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, target)
    // The rename is the commit point: once it lands, the consumption is on
    // disk even if the directory fsync below fails.
    if (onRenamed) onRenamed()
    fsyncDirectory(directory)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temporary)
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
}

function assertConsumableDispatch(paths) {
  if (entryExists(paths.tombstone)) fail('tombstone exists')
  const ledger = readJsonFile(paths.ledger, 'ledger', MAX_LEDGER_BYTES)
  if (ledger.run_id !== paths.runId) fail('ledger run_id does not match CLI run-id')
  if (ledger.status !== 'dispatched') fail(`ledger status is not dispatched: ${ledger.status}`)
  if (ledger.outstanding_dispatch_id !== paths.dispatchId) fail('ledger outstanding dispatch mismatch')
  if (ledger.attempt?.dispatch_id !== paths.dispatchId) fail('ledger attempt dispatch mismatch')
  if (ledger.attempt?.receiver_receipt_path !== paths.receiver) {
    fail('ledger receiver path is not the canonical receiver for this run and dispatch')
  }
  if (ledger.coordinator?.task_id !== paths.coordinatorTaskId) fail('coordinator task mismatch')
  const stopAt = ledger.attempt_limits?.stop_at
  if (typeof stopAt !== 'string' || !RFC3339.test(stopAt) || !Number.isFinite(Date.parse(stopAt))) {
    fail('ledger attempt_limits.stop_at must be an RFC 3339 timestamp')
  }
  // stop_at bounds project work and automatic redispatch, not the one-time
  // acceptance of a receipt that was already released inside its deadline;
  // late released receipts stay consumable here exactly once.
  if (ledger.revision !== paths.expectedRevision) fail(`revision mismatch: ${ledger.revision}`)
  if (Array.isArray(ledger.handled_dispatch_ids) && ledger.handled_dispatch_ids.includes(paths.dispatchId)) {
    fail('dispatch already handled')
  }
  if (entryExists(paths.tombstone)) fail('tombstone exists')
  return ledger
}

function readReleasedReceipt(paths, ledger) {
  let receiverStat
  try {
    receiverStat = lstatSync(paths.receiver)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('receiver directory does not exist')
    throw error
  }
  if (receiverStat.isSymbolicLink() || !receiverStat.isDirectory()) {
    fail('receiver must be a real directory, not a symlink')
  }
  if (entryExists(`${paths.receiver}/.transition.lock`)) fail('receipt transition is in progress')
  const receipt = readJsonFile(`${paths.receiver}/receipt.json`, 'receipt', MAX_RECEIPT_BYTES)
  if (entryExists(`${paths.receiver}/.transition.lock`)) fail('receipt transition is in progress')
  if (
    receipt.protocol !== RECEIPT_PROTOCOL
    || receipt.run_id !== paths.runId
    || receipt.dispatch_id !== paths.dispatchId
    || receipt.coordinator_task_id !== paths.coordinatorTaskId
    || receipt.stop_at !== ledger.attempt_limits?.stop_at
    || receipt.status !== 'released'
    || !OUTCOMES.has(receipt.outcome)
    || !UUID.test(receipt.receiver_id)
  ) {
    fail('released receipt identity does not match ledger and envelope')
  }
  return receipt
}

function readHolder(paths) {
  const holder = readJsonFile(`${paths.lock}/holder.json`, 'review holder', 16 * 1024)
  if (
    !UUID.test(holder.holder_id)
    || holder.coordinator_task_id !== paths.coordinatorTaskId
    || !Number.isSafeInteger(holder.acquired_at_revision)
  ) {
    fail('retained review holder is malformed')
  }
  return holder
}

// Mirrors the trusted entry: mkdir is the mutex, holder.json is the durable
// ownership record, fsync of file + lock dir + state dir makes it survive a
// crash, and the CAS is re-checked after acquisition and right before the
// replace. The lock is retained on success; only the failure path removes it,
// after re-verifying we still own it.
function withReviewLock(paths, expectedRevision, work) {
  try {
    mkdirSync(paths.lock, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') fail('review lock already exists; ownership is not stolen')
    throw error
  }
  fsyncDirectory(paths.stateDir)
  // Declared out here so the catch can compare owner identity; a holder id
  // const inside the try block is invisible to the catch block.
  let holderId = null
  const phase = { committed: false }
  try {
    holderId = randomUUID()
    const holder = {
      acquired_at: new Date().toISOString(),
      acquired_at_revision: expectedRevision,
      coordinator_task_id: paths.coordinatorTaskId,
      holder_id: holderId,
    }
    const holderPath = `${paths.lock}/holder.json`
    const fd = openSync(holderPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(holder, null, 2)}\n`, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    fsyncDirectory(paths.lock)
    fsyncDirectory(paths.stateDir)
    const written = readHolder(paths)
    if (written.holder_id !== holderId) fail('review holder verification failed')
    return work(holderId, phase)
  } catch (error) {
    if (!phase.committed && holderId !== null) {
      let owned = false
      try {
        const written = readHolder(paths)
        owned = written.holder_id === holderId
          && written.acquired_at_revision === expectedRevision
      } catch {
        owned = false
      }
      if (owned) {
        // Uncommitted and provably ours: stand down as sibling evidence so a
        // retry can reconcile once the fault clears. A lock we cannot prove
        // as ours stays exactly where it is.
        try {
          const abandoned = `${paths.stateDir}/${basename(paths.lock)}.abandoned-${randomUUID()}`
          renameSync(paths.lock, abandoned)
          fsyncDirectory(paths.stateDir)
        } catch {
          // Keep the lock in place as fail-closed evidence.
        }
      }
    }
    // Committed failures fail closed: the ledger already carries the
    // consumption, so the lock and holder stay as the inspectable scene.
    throw error
  }
}

// Owner-only unlock: the lock is removed only while holder.json still proves
// this exact holder owns it; otherwise it stays as fail-closed evidence.
function releaseConsumptionLock(paths, holderId) {
  const owner = readHolder(paths)
  if (owner.holder_id !== holderId) fail('refusing to release a consumption lock we do not own')
  if (owner.acquired_at_revision !== paths.expectedRevision) fail('refusing to release a lock acquired at a different revision')
  rmSync(paths.lock, { recursive: true, force: false })
  fsyncDirectory(paths.stateDir)
}

function reconcile(paths) {
  const ledgerBefore = assertConsumableDispatch(paths)
  const receipt = readReleasedReceipt(paths, ledgerBefore)
  const outcome = receipt.outcome
  const stopLike = outcome !== 'completed'
  return withReviewLock(paths, paths.expectedRevision, (holderId, phase) => {
    const fresh = assertConsumableDispatch(paths)
    if (
      fresh.outstanding_dispatch_id !== ledgerBefore.outstanding_dispatch_id
      || fresh.attempt_limits?.stop_at !== ledgerBefore.attempt_limits?.stop_at
    ) {
      fail('ledger changed under the review lock')
    }
    const consumedAt = new Date().toISOString()
    const next = stopLike
      ? {
          ...fresh,
          handled_dispatch_ids: [...(fresh.handled_dispatch_ids ?? []), paths.dispatchId],
          message_type: outcome,
          callback_delivery_status: fresh.callback_delivery_status ?? null,
          outstanding_dispatch_id: null,
          revision: fresh.revision + 1,
          status: 'stopped',
          stop_reason: typeof receipt.reason === 'string' && receipt.reason.length > 0
            ? receipt.reason
            : `${outcome} callback received via receipt reconciliation`,
          stopped_at: consumedAt,
        }
      : {
          ...fresh,
          handled_dispatch_ids: [...(fresh.handled_dispatch_ids ?? []), paths.dispatchId],
          message_type: 'completed',
          callback_delivery_status: fresh.callback_delivery_status ?? null,
          reviewing_at: consumedAt,
          revision: fresh.revision + 1,
          status: 'reviewing',
        }
    const stillOurs = readHolder(paths)
    if (stillOurs.holder_id !== holderId) fail('review holder changed before CAS')
    assertConsumableDispatch(paths)
    atomicWriteJson(paths.stateDir, paths.ledger, next, () => { phase.committed = true })
    if (stopLike) releaseConsumptionLock(paths, holderId)
    return {
      dispatch_id: paths.dispatchId,
      message_type: outcome,
      receipt_reconciliation: true,
      revision: next.revision,
      status: next.status,
      ...(stopLike ? {} : { holder_id: holderId }),
    }
  })
}

function holder(paths) {
  if (entryExists(paths.tombstone)) fail('tombstone exists')
  const ledger = readJsonFile(paths.ledger, 'ledger', MAX_LEDGER_BYTES)
  if (ledger.run_id !== paths.runId) fail('ledger run_id does not match CLI run-id')
  if (ledger.coordinator?.task_id !== paths.coordinatorTaskId) fail('coordinator task mismatch')
  if (ledger.status !== 'reviewing') fail('resume route requires a ledger in reviewing status')
  if (ledger.outstanding_dispatch_id !== paths.dispatchId) fail('ledger outstanding dispatch mismatch')
  if (ledger.attempt?.dispatch_id !== paths.dispatchId) fail('ledger attempt dispatch mismatch')
  if (!ledger.handled_dispatch_ids?.includes(paths.dispatchId)) fail('dispatch is not recorded as handled')
  if (ledger.revision !== paths.expectedRevision) fail(`revision mismatch: ${ledger.revision}`)
  const holder = readHolder(paths)
  if (holder.acquired_at_revision !== ledger.revision - 1) fail('retained holder does not match the reviewing revision')
  return {
    dispatch_id: paths.dispatchId,
    holder_id: holder.holder_id,
    revision: ledger.revision,
    status: ledger.status,
  }
}

function main() {
  const { command, options, expectedRevision } = parseArgs(process.argv.slice(2))
  const paths = validatePaths(options)
  paths.expectedRevision = expectedRevision
  const result = command === 'reconcile' ? reconcile(paths) : holder(paths)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`)
  process.exitCode = 1
}
