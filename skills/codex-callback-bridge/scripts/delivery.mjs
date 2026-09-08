#!/usr/bin/env node

// Deterministic state machine for bounded, recoverable callback delivery.
// It owns persistence, attempt accounting, locking, and stop conditions only.
// It never drives the UI itself: the worker re-locates the exact Codex task,
// re-validates the unique final anchor, and feeds observed results back in.

import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

const PROTOCOL = 'zcode-callback-delivery/v1'
const RECEIPT_PROTOCOL = 'zcode-callback-receipt/v1'
const MAX_STATE_BYTES = 64 * 1024
const MAX_LEDGER_BYTES = 1024 * 1024
const MAX_LOCK_BYTES = 4 * 1024
const MAX_HISTORY = 50
const TARGET_CHECK_MAX_AGE_MS = 30_000
const LOCK_LEASE_MS = 120_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const FIRST_LINES = {
  completed: '已完成，等待下一步指示',
  blocked: '任务受阻，等待下一步指示',
  needs_decision: '需要决策，等待下一步指示',
}
const MESSAGE_TYPES = new Set(Object.keys(FIRST_LINES))
const STATES = new Set([
  'queued',
  'waiting_backoff',
  'in_attempt',
  'needs_verification',
  'confirmed',
  'stopped',
  'parked',
])
const TERMINAL_STATES = new Set(['confirmed', 'stopped', 'parked'])
const RESULTS = new Set(['unsent', 'sent_unconfirmed', 'confirmed'])
const STOP_REASONS = new Set([
  'delivery_deadline_expired',
  'run_cancelled',
  'coordinator_handled',
  'target_mismatch',
  'authority_lost',
])
const MAX_COUNT = 1_000_000
const MAX_HISTORY_ENTRIES = 200
const COMMANDS = [
  'enqueue',
  'recover',
  'note-block',
  'status',
  'begin-attempt',
  'record-result',
  'verify',
  'release-attempt',
  'reclaim-stale-lock',
  'record-stop',
  'render-message',
]

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const [command, ...tokens] = argv
  if (!COMMANDS.includes(command)) {
    fail(`usage: delivery.mjs <${COMMANDS.join('|')}> ...`)
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

  const required = {
    enqueue: [
      'state-dir', 'run-id', 'dispatch-id', 'coordinator-task-id',
      'codex-project', 'codex-task-title', 'ledger-path', 'tombstone-path',
      'receiver-path', 'receipt-dir', 'message-type', 'work-stop-at',
      'delivery-deadline',
    ],
    recover: [
      'state-dir', 'run-id', 'dispatch-id', 'coordinator-task-id',
      'codex-project', 'codex-task-title', 'ledger-path', 'tombstone-path',
      'receiver-path', 'receipt-dir', 'message-type', 'work-stop-at',
    ],
    'note-block': ['state', 'reason', 'evidence'],
    status: ['state'],
    'begin-attempt': ['state', 'owner', 'owner-pid', 'target-verified-at'],
    'record-result': ['state', 'owner', 'owner-pid', 'result', 'evidence'],
    verify: ['state', 'owner', 'owner-pid', 'found', 'evidence', 'target-verified-at'],
    'release-attempt': ['state', 'owner', 'reason'],
    'reclaim-stale-lock': ['state', 'owner', 'prior-owner', 'evidence'],
    'record-stop': ['state', 'reason', 'evidence'],
    'render-message': ['state'],
  }[command]
  for (const key of required) {
    if (!options[key]) fail(`missing required argument --${key}`)
  }
  return { command, options }
}

function parseMs(value, label) {
  if (/^\d+$/.test(value)) {
    const ms = Number(value)
    if (Number.isSafeInteger(ms)) return ms
  }
  if (RFC3339.test(value) && Number.isFinite(Date.parse(value))) return Date.parse(value)
  fail(`${label} must be an epoch-milliseconds integer or an RFC 3339 timestamp`)
}

function parseInteger(value, label) {
  if (!/^-?\d+$/.test(value)) fail(`${label} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) fail(`${label} is out of range`)
  return parsed
}

function toIso(ms) {
  return new Date(ms).toISOString()
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) fail('attempt lock pid is invalid')
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function assertAbsolutePath(value, label) {
  if (!isAbsolute(value) || resolve(value) !== value) {
    fail(`${label} path must be absolute and normalized`)
  }
}

function assertRealDirectory(path, label) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real directory`)
  }
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular file`)
  }
}

function readJsonFile(path, label, maxBytes) {
  assertRegularFile(path, label)
  const stat = lstatSync(path)
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

function atomicWriteJson(directory, target, value) {
  const temporary = `${directory}/.delivery.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, target)
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

function waitBusySync(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // bounded busy wait; critical sections here are single-digit milliseconds
  }
}

function stateMutexPath(statePath) {
  return `${statePath.replace(/\.pending\.json$/, '')}.state.lock`
}

function withStateMutex(statePath, work) {
  const path = stateMutexPath(statePath)
  // The owner identity is published atomically: the identity file is written in
  // full BEFORE it is linked to the mutex path, so a holder suspended anywhere
  // can never present an empty or torn lock, and no competitor ever has to guess
  // whether an unknown lock might belong to a live process.
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquired_at: toIso(Date.now()) })}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  let published = false
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        linkSync(temp, path)
        published = true
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        // The mutex is owned by someone else, and ownership is never judged from
        // liveness: even a proven-dead pid does not authorize removing the lock,
        // because a dead-reclaimer can delete a live successor's lock. Competitors
        // wait briefly for a live holder's normal release, then fail closed for
        // manual reconciliation. Automatic reclamation is disabled by design.
        waitBusySync(25)
      }
    }
    if (!published) {
      fail('delivery state mutex is busy or unresolvable; re-read status and retry, or reconcile the unknown lock manually')
    }
    return work()
  } finally {
    if (published) {
      // Release only while the path still refers to the very inode we published.
      // If it changed hands, the new owner's lock must survive.
      try {
        if (statSync(path).ino === statSync(temp).ino) {
          unlinkSync(path)
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') throw cleanupError
      }
    }
    try {
      unlinkSync(temp)
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError
    }
  }
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

function messageText(messageType, runId, dispatchId) {
  return [
    FIRST_LINES[messageType],
    `message_type: ${messageType}`,
    `run_id: ${runId}`,
    `dispatch_id: ${dispatchId}`,
  ].join('\n')
}

function lockPathFor(statePath) {
  return `${statePath.replace(/\.pending\.json$/, '')}.attempt.lock`
}

function backoffFor(attempts, policy) {
  const shifted = Math.min(attempts - 1, 16)
  return Math.min(policy.backoff_base_ms * 2 ** Math.max(shifted, 0), policy.backoff_cap_ms)
}

function assertAuthorityLive(record) {
  const envelope = record.envelope
  if (entryExists(envelope.tombstone_path)) {
    fail('the run is cancelled (tombstone exists); delivery authorization is revoked')
  }
  const ledger = readJsonFile(envelope.ledger_path, 'ledger', MAX_LEDGER_BYTES)
  if (ledger.run_id !== envelope.run_id) fail('ledger identity does not match the bound run')
  if (ledger.coordinator?.task_id !== envelope.coordinator_task_id) {
    fail('ledger coordinator does not match the bound coordinator')
  }
  if (ledger.status !== 'dispatched') {
    fail(`ledger status is ${JSON.stringify(ledger.status ?? null)}; this dispatch is no longer outstanding`)
  }
  if (ledger.outstanding_dispatch_id !== envelope.dispatch_id) {
    fail('the outstanding dispatch has advanced past this delivery; re-delivery is not authorized')
  }
  if (Array.isArray(ledger.handled_dispatch_ids) && ledger.handled_dispatch_ids.includes(envelope.dispatch_id)) {
    fail('the coordinator has already handled this dispatch; re-delivery is not authorized')
  }
  if (ledger.attempt?.dispatch_id !== envelope.dispatch_id) {
    fail('the ledger attempt no longer matches this dispatch')
  }
  const receiptOnDisk = readJsonFile(record.receipt.receipt_path, 'released receipt', MAX_STATE_BYTES)
  if (
    receiptOnDisk.protocol !== RECEIPT_PROTOCOL
    || receiptOnDisk.run_id !== envelope.run_id
    || receiptOnDisk.dispatch_id !== envelope.dispatch_id
    || receiptOnDisk.coordinator_task_id !== envelope.coordinator_task_id
    || receiptOnDisk.stop_at !== envelope.work_stop_at
    || receiptOnDisk.receiver_id !== record.receipt.receiver_id
    || receiptOnDisk.status !== 'released'
    || receiptOnDisk.outcome !== record.message.message_type
  ) {
    fail('the bound released receipt is missing, terminal-invalid, or drifted; delivery authorization is revoked')
  }
}

function authorityStopReason(record) {
  if (entryExists(record.envelope.tombstone_path)) return 'run_cancelled'
  let ledger = null
  let receipt = null
  try {
    ledger = readJsonFile(record.envelope.ledger_path, 'ledger', MAX_LEDGER_BYTES)
  } catch {
    ledger = null
  }
  try {
    receipt = readJsonFile(record.receipt.receipt_path, 'released receipt', MAX_STATE_BYTES)
  } catch {
    receipt = null
  }
  if (ledger && ledger.run_id === record.envelope.run_id && ledger.coordinator?.task_id === record.envelope.coordinator_task_id) {
    if (
      ledger.status !== 'dispatched'
      || ledger.outstanding_dispatch_id !== record.envelope.dispatch_id
      || (Array.isArray(ledger.handled_dispatch_ids) && ledger.handled_dispatch_ids.includes(record.envelope.dispatch_id))
    ) return 'coordinator_handled'
  }
  if (receipt && (receipt.protocol !== RECEIPT_PROTOCOL || receipt.status !== 'released')) return 'authority_lost'
  return null
}

function recommendedActionFor(record) {
  switch (record.state) {
    case 'queued':
      return 'resume_attempt'
    case 'waiting_backoff':
      return 'wait_and_retry'
    case 'in_attempt':
      return 'attempt_in_progress'
    case 'needs_verification':
      return 'verify_existing'
    case 'confirmed':
      return 'none_confirmed'
    case 'parked':
      return 'manual_review'
    case 'stopped':
      return 'none_stopped'
    default:
      fail(`unknown delivery state ${record.state}`)
  }
}

function pushHistory(record, event, details) {
  record.history.push({ at: toIso(record._now), event, ...details })
  if (record.history.length > MAX_HISTORY) {
    record.history.splice(0, record.history.length - MAX_HISTORY)
  }
}

function saveState(statePath, record) {
  if (entryExists(statePath)) {
    const disk = JSON.parse(readFileSync(statePath, 'utf8'))
    if (disk.generation !== record._loadedGeneration) {
      fail('delivery record changed concurrently; re-read status and retry')
    }
  }
  record.generation = (record._loadedGeneration ?? 0) + 1
  record.updated_at = toIso(record._now)
  const snapshot = { ...record }
  delete snapshot._now
  delete snapshot._loadedGeneration
  atomicWriteJson(dirname(statePath), statePath, snapshot)
}

function isRfc3339(value) {
  return typeof value === 'string' && RFC3339.test(value) && Number.isFinite(Date.parse(value))
}

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT
}

function assertStateSchema(record) {
  const detail = (message) => fail(`pending delivery record failed schema validation: ${message}`)
  const envelope = record.envelope
  if (typeof envelope !== 'object' || envelope === null) detail('envelope missing')
  for (const key of ['run_id', 'dispatch_id', 'coordinator_task_id', 'codex_project', 'codex_task_title', 'ledger_path', 'tombstone_path', 'receiver_path', 'work_stop_at']) {
    if (typeof envelope[key] !== 'string' || !envelope[key]) detail(`envelope.${key} missing`)
  }
  if (!UUID.test(envelope.run_id)) detail('envelope.run_id is not a lowercase UUID')
  if (!UUID.test(envelope.dispatch_id)) detail('envelope.dispatch_id is not a lowercase UUID')
  if (!isRfc3339(envelope.work_stop_at)) detail('envelope.work_stop_at is not RFC 3339')
  assertAbsolutePath(envelope.ledger_path, 'envelope.ledger_path')
  assertAbsolutePath(envelope.tombstone_path, 'envelope.tombstone_path')
  assertAbsolutePath(envelope.receiver_path, 'envelope.receiver_path')
  if (basename(envelope.ledger_path) !== `${envelope.run_id}.json`) detail('ledger_path naming drifted')
  if (basename(envelope.tombstone_path) !== `${envelope.run_id}.tombstone`) detail('tombstone_path naming drifted')
  if (basename(envelope.receiver_path) !== `${envelope.run_id}.${envelope.dispatch_id}.receiver`) detail('receiver_path naming drifted')
  const runsDir = dirname(envelope.ledger_path)
  if (basename(runsDir) !== 'zcode-runs' || dirname(envelope.tombstone_path) !== runsDir || dirname(envelope.receiver_path) !== runsDir) {
    detail('envelope state paths do not share one zcode-runs directory')
  }

  const receipt = record.receipt
  if (typeof receipt !== 'object' || receipt === null) detail('receipt binding missing')
  if (!UUID.test(receipt.receiver_id)) detail('receipt.receiver_id is not a lowercase UUID')
  if (receipt.status !== 'released') detail('receipt binding is not a released receipt')
  if (!MESSAGE_TYPES.has(receipt.outcome)) detail('receipt.outcome is not a canonical message type')
  if (receipt.receipt_path !== `${envelope.receiver_path}/receipt.json`) detail('receipt_path drifted from the receiver binding')

  if (!MESSAGE_TYPES.has(record.message?.message_type)) detail('message.type is not canonical')
  if (record.message.message_type !== receipt.outcome) detail('message type drifted from the released receipt outcome')

  if (!isRfc3339(record.delivery_deadline)) detail('delivery_deadline is not RFC 3339')
  if (record.delivery_deadline_ms !== Date.parse(record.delivery_deadline)) detail('delivery_deadline_ms disagrees with delivery_deadline')
  if (!isRfc3339(record.next_eligible_at) || record.next_eligible_ms !== Date.parse(record.next_eligible_at)) {
    detail('next_eligible instants disagree')
  }
  if (!isRfc3339(record.created_at) || !isRfc3339(record.updated_at)) detail('record instants are not RFC 3339')
  if (!isCount(record.attempts) || !isCount(record.attempts_started)) detail('attempt counters must be non-negative integers')
  if (record.attempts_started < record.attempts) detail('attempts_started is smaller than attempts')
  if (!isCount(record.generation)) detail('generation must be a non-negative integer')

  const policy = record.policy
  if (typeof policy !== 'object' || policy === null) detail('policy missing')
  if (!isCount(policy.max_attempts) || policy.max_attempts < 1) detail('policy.max_attempts must be a positive integer')
  if (!isCount(policy.backoff_base_ms) || policy.backoff_base_ms < 1) detail('policy.backoff_base_ms must be positive')
  if (!isCount(policy.backoff_cap_ms) || policy.backoff_cap_ms < policy.backoff_base_ms) detail('policy.backoff_cap_ms must not be below base')
  if (!isCount(policy.target_check_max_age_ms) || policy.target_check_max_age_ms < 1) detail('policy.target_check_max_age_ms must be positive')
  if (!isCount(policy.lock_lease_ms) || policy.lock_lease_ms < 1) detail('policy.lock_lease_ms must be positive')

  if (!Array.isArray(record.history) || record.history.length > MAX_HISTORY_ENTRIES) detail('history is malformed')
  if (record.owner !== null && typeof record.owner !== 'string') detail('owner must be null or a string')
  if (record.last_error !== null && typeof record.last_error !== 'object') detail('last_error must be null or an object')
  if (record.verify_charge_pending !== undefined && typeof record.verify_charge_pending !== 'boolean') detail('verify_charge_pending must be boolean')

  if (record.record_version !== undefined && record.record_version !== BUDGET_RECORD_VERSION) {
    detail('record_version is not a supported budget record version')
  }
  if (record.record_version === BUDGET_RECORD_VERSION) {
    // New records carry the durable location budget; a present-but-missing,
    // malformed, or over-bounds counter is tampering and is refused without
    // any repair, keeping the on-disk bytes exactly as they are.
    if (!isCount(record.location_blocks_total)) detail('location_blocks_total must be a non-negative integer on a versioned record')
    if (record.location_blocks_total > LOCATION_BLOCKS_MAX) detail('location_blocks_total exceeds the documented upper bound')
  } else if (record.location_blocks_total !== undefined) {
    // Old records predate the field; if a value is present anyway it must
    // still be well-formed, never silently repaired from history.
    if (!isCount(record.location_blocks_total)) detail('location_blocks_total must be a non-negative integer')
    if (record.location_blocks_total > LOCATION_BLOCKS_MAX) detail('location_blocks_total exceeds the documented upper bound')
  }

  const receiptOnDisk = readJsonFile(receipt.receipt_path, 'released receipt', MAX_STATE_BYTES)
  if (
    receiptOnDisk.protocol !== RECEIPT_PROTOCOL
    || receiptOnDisk.run_id !== envelope.run_id
    || receiptOnDisk.dispatch_id !== envelope.dispatch_id
    || receiptOnDisk.coordinator_task_id !== envelope.coordinator_task_id
    || receiptOnDisk.stop_at !== envelope.work_stop_at
    || receiptOnDisk.receiver_id !== receipt.receiver_id
    || receiptOnDisk.status !== 'released'
    || receiptOnDisk.outcome !== record.message.message_type
  ) detail('released receipt no longer matches the bound delivery identity')
}

function loadState(statePath, now) {
  if (!entryExists(statePath)) fail(`no pending delivery record at ${statePath}`)
  const record = readJsonFile(statePath, 'pending delivery record', MAX_STATE_BYTES)
  if (record.protocol !== PROTOCOL) fail('pending delivery record protocol mismatch')
  if (!STATES.has(record.state)) fail(`unknown delivery state ${record.state}`)
  if (record.delivery_id !== `${record.envelope?.run_id}.${record.envelope?.dispatch_id}`) {
    fail('pending delivery record identity mismatch')
  }
  assertStateSchema(record)
  record._now = now
  record._loadedGeneration = record.generation
  return record
}

function readLock(statePath) {
  const path = lockPathFor(statePath)
  if (!entryExists(path)) return null
  const lock = readJsonFile(path, 'attempt lock', MAX_LOCK_BYTES)
  if (lock.protocol !== PROTOCOL || lock.delivery_id !== basename(statePath).replace(/\.pending\.json$/, '')) {
    fail('attempt lock identity mismatch')
  }
  return lock
}

function acquireLock(statePath, record, owner, pid) {
  const path = lockPathFor(statePath)
  const payload = {
    protocol: PROTOCOL,
    delivery_id: record.delivery_id,
    owner,
    pid,
    acquired_at: toIso(record._now),
    lease_expires_at: toIso(record._now + LOCK_LEASE_MS),
  }
  let fd
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  try {
    writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    fsyncDirectory(dirname(statePath))
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return true
}

function releaseLock(statePath, record, owner) {
  const path = lockPathFor(statePath)
  if (!entryExists(path)) return
  const lock = readJsonFile(path, 'attempt lock', MAX_LOCK_BYTES)
  if (lock.owner !== owner) fail('attempt lock does not belong to this owner')
  unlinkSync(path)
  fsyncDirectory(dirname(statePath))
}

function readReleasedReceipt(options, runId, dispatchId, coordinatorTaskId) {
  assertAbsolutePath(options['receipt-dir'], 'receipt-dir')
  if (basename(options['receipt-dir']) !== `${runId}.${dispatchId}.receiver`) {
    fail('receipt-dir path does not match run and dispatch IDs')
  }
  assertRealDirectory(options['receipt-dir'], 'receipt directory')
  const receiptPath = `${options['receipt-dir']}/receipt.json`
  const receipt = readJsonFile(receiptPath, 'released receipt', MAX_STATE_BYTES)
  if (
    receipt.protocol !== RECEIPT_PROTOCOL
    || receipt.run_id !== runId
    || receipt.dispatch_id !== dispatchId
    || receipt.coordinator_task_id !== coordinatorTaskId
  ) {
    fail('released receipt identity mismatch')
  }
  if (receipt.status !== 'released' || !MESSAGE_TYPES.has(receipt.outcome)) {
    fail('receipt is not a released terminal receipt')
  }
  return { receipt, receiptPath }
}

function validateDeliveryInstant(options, now) {
  const deliveryDeadline = options['delivery-deadline']
  if (!RFC3339.test(deliveryDeadline) || !Number.isFinite(Date.parse(deliveryDeadline))) {
    fail('delivery-deadline must be an RFC 3339 timestamp with an offset')
  }
  if (!RFC3339.test(options['work-stop-at'])) {
    fail('work-stop-at must be an RFC 3339 timestamp with an offset')
  }
  const deadlineMs = Date.parse(deliveryDeadline)
  if (deadlineMs <= now) fail('delivery deadline has already passed')
  return { deliveryDeadline, deadlineMs }
}

function identityOf(record) {
  return {
    envelope: record.envelope,
    receipt: record.receipt,
    message: record.message,
    delivery_deadline: record.delivery_deadline,
    policy: record.policy,
  }
}

function enqueue(options) {
  const now = options._now
  const runId = options['run-id']
  const dispatchId = options['dispatch-id']
  const coordinatorTaskId = options['coordinator-task-id']
  if (!UUID.test(runId)) fail('run-id must be a lowercase UUID')
  if (!UUID.test(dispatchId)) fail('dispatch-id must be a lowercase UUID')
  if (!MESSAGE_TYPES.has(options['message-type'])) {
    fail('message-type must be completed, blocked, or needs_decision')
  }
  if (!options['codex-project'] || !options['codex-task-title']) {
    fail('codex-project and codex-task-title must be non-empty')
  }

  const stateDir = options['state-dir']
  assertAbsolutePath(stateDir, 'state-dir')
  assertRealDirectory(stateDir, 'state directory')
  const statePath = `${stateDir}/${runId}.${dispatchId}.pending.json`

  for (const [flag, expected, label] of [
    ['ledger-path', `${runId}.json`, 'ledger'],
    ['tombstone-path', `${runId}.tombstone`, 'tombstone'],
    ['receiver-path', `${runId}.${dispatchId}.receiver`, 'receiver'],
  ]) {
    assertAbsolutePath(options[flag], label)
    if (basename(options[flag]) !== expected) {
      fail(`${label} path does not match run and dispatch IDs`)
    }
  }
  const runsDir = dirname(options['ledger-path'])
  if (dirname(options['tombstone-path']) !== runsDir || dirname(options['receiver-path']) !== runsDir) {
    fail('ledger, tombstone, and receiver must share one state directory')
  }
  if (basename(runsDir) !== 'zcode-runs') fail('state directory must be named zcode-runs')

  const { receipt, receiptPath } = readReleasedReceipt(options, runId, dispatchId, coordinatorTaskId)
  if (receipt.outcome !== options['message-type']) {
    fail('message type does not match released receipt outcome')
  }
  if (entryExists(options['tombstone-path'])) {
    fail('the run is cancelled (tombstone exists); a pending delivery record cannot be created')
  }
  const ledgerNow = readJsonFile(options['ledger-path'], 'ledger', MAX_LEDGER_BYTES)
  if (
    ledgerNow.run_id !== runId
    || ledgerNow.coordinator?.task_id !== coordinatorTaskId
    || ledgerNow.status !== 'dispatched'
    || ledgerNow.outstanding_dispatch_id !== dispatchId
    || ledgerNow.attempt?.dispatch_id !== dispatchId
    || (Array.isArray(ledgerNow.handled_dispatch_ids) && ledgerNow.handled_dispatch_ids.includes(dispatchId))
  ) {
    fail('the ledger shows this dispatch is no longer outstanding; a pending delivery record cannot be created')
  }
  const { deliveryDeadline, deadlineMs } = validateDeliveryInstant(options, now)

  const maxAttempts = options['max-attempts'] === undefined ? 5 : parseInteger(options['max-attempts'], 'max-attempts')
  const backoffBase = options['backoff-base-ms'] === undefined
    ? 5000
    : parseInteger(options['backoff-base-ms'], 'backoff-base-ms')
  const backoffCap = options['backoff-cap-ms'] === undefined
    ? 60_000
    : parseInteger(options['backoff-cap-ms'], 'backoff-cap-ms')
  if (maxAttempts < 1 || backoffBase < 1 || backoffCap < backoffBase) {
    fail('delivery policy numbers are invalid')
  }

  const record = {
    protocol: PROTOCOL,
    delivery_id: `${runId}.${dispatchId}`,
    envelope: {
      run_id: runId,
      dispatch_id: dispatchId,
      coordinator_task_id: coordinatorTaskId,
      codex_project: options['codex-project'],
      codex_task_title: options['codex-task-title'],
      ledger_path: options['ledger-path'],
      tombstone_path: options['tombstone-path'],
      receiver_path: options['receiver-path'],
      work_stop_at: options['work-stop-at'],
    },
    receipt: {
      receiver_id: receipt.receiver_id,
      outcome: receipt.outcome,
      status: 'released',
      receipt_path: receiptPath,
    },
    message: { message_type: options['message-type'] },
    policy: {
      max_attempts: maxAttempts,
      backoff_base_ms: backoffBase,
      backoff_cap_ms: backoffCap,
      target_check_max_age_ms: TARGET_CHECK_MAX_AGE_MS,
      lock_lease_ms: LOCK_LEASE_MS,
    },
    delivery_deadline: deliveryDeadline,
    delivery_deadline_ms: deadlineMs,
    record_version: BUDGET_RECORD_VERSION,
    location_blocks_total: 0,
    state: 'queued',
    attempts: 0,
    attempts_started: 0,
    owner: null,
    next_eligible_at: toIso(now),
    next_eligible_ms: now,
    eligible_since_ms: 0,
    last_error: null,
    history: [],
    created_at: toIso(now),
    updated_at: toIso(now),
    generation: 0,
  }
  record._now = now
  pushHistory(record, options._recover ? 'recover' : 'enqueue', { message_type: options['message-type'] })

  if (entryExists(statePath)) {
    const existing = loadState(statePath, now)
    if (JSON.stringify(identityOf(existing)) !== JSON.stringify(identityOf(record))) {
      fail('pending delivery record already exists with a different identity')
    }
    return { created: false, delivery_id: existing.delivery_id, state: existing.state }
  }
  saveState(statePath, record)
  return { created: true, delivery_id: record.delivery_id, state: record.state }
}

function assertSendableState(record) {
  if (record.state === 'confirmed') fail('delivery is already confirmed; never send again')
  if (record.state === 'stopped') fail(`delivery is stopped (${record.last_error?.reason ?? 'unknown reason'})`)
  if (record.state === 'parked') fail(`delivery is parked (${record.last_error?.reason ?? 'unknown reason'})`)
  if (record.state === 'needs_verification') {
    fail('delivery is in needs_verification; a re-send is not authorized until absence is proven')
  }
}

function checkDeadline(record) {
  if (record._now >= record.delivery_deadline_ms) {
    record.state = 'stopped'
    record.owner = null
    record.last_error = { reason: 'delivery_deadline_expired', at: toIso(record._now) }
    pushHistory(record, 'stop', { reason: 'delivery_deadline_expired' })
    return false
  }
  return true
}

function assertFreshTargetCheck(options, record) {
  const verifiedAt = parseMs(options['target-verified-at'], 'target-verified-at')
  const age = record._now - verifiedAt
  if (verifiedAt > record._now || age > record.policy.target_check_max_age_ms) {
    fail('target verification is stale; re-locate the exact task and re-validate the unique final anchor')
  }
  const actionable = record.state === 'waiting_backoff' || record.state === 'needs_verification'
  if (actionable && verifiedAt <= (record.eligible_since_ms ?? 0)) {
    fail('target verification is stale; it predates the current backoff, so re-locate and re-validate after waking')
  }
}

function beginAttempt(options) {
  const statePath = options.state
  const now = options._now
  const owner = options.owner
  const pid = parseInteger(options['owner-pid'], 'owner-pid')
  if (pid <= 0) fail('owner-pid must be a positive integer')
  let record = loadState(statePath, now)

  assertSendableState(record)
  assertAuthorityLive(record)
  if (!checkDeadline(record)) {
    saveState(statePath, record)
    fail('delivery deadline has passed; the pending record is retained as stopped')
  }
  if (record.attempts >= record.policy.max_attempts) {
    fail('attempt budget exhausted; the record is parked or must be parked before any further send')
  }
  if (record.state === 'waiting_backoff' && now < record.next_eligible_ms) {
    fail('backoff has not elapsed; wait until next_eligible_at')
  }
  assertFreshTargetCheck(options, record)

  const existingLock = readLock(statePath)
  if (record.state === 'in_attempt' && !existingLock) {
    // Crash aftermath: the previous owner may have already sent. Treat as uncertain.
    record.state = 'needs_verification'
    record.owner = null
    record.eligible_since_ms = now
    record.verify_charge_pending = true
    pushHistory(record, 'crash_self_heal', { detail: 'in_attempt without attempt lock; requires verification before any re-send' })
    saveState(statePath, record)
    fail('delivery was left in_attempt without a lock; it is now needs_verification and must be verified before any re-send')
  }
  if (existingLock) {
    if (record.state !== 'in_attempt') {
      // Orphan lock from a crash after the state was saved but before release.
      if (isPidAlive(existingLock.pid)) {
        fail(`attempt lock held by ${existingLock.owner} (pid ${existingLock.pid} alive)`)
      }
      unlinkSync(lockPathFor(statePath))
      fsyncDirectory(dirname(statePath))
      pushHistory(record, 'orphan_lock_discarded', { prior_owner: existingLock.owner })
    } else if (existingLock.owner === owner && existingLock.pid === pid) {
      return { status: 'attempt_resumed', delivery_id: record.delivery_id, owner }
    } else if (existingLock.owner === owner) {
      fail('attempt lock is held by the same owner token under a different process; owner tokens must be unique per recoverer')
    } else if (isPidAlive(existingLock.pid)) {
      fail(`attempt lock held by ${existingLock.owner} (pid ${existingLock.pid} alive)`)
    } else {
      fail('stale attempt lock requires explicit reclaim (reclaim-stale-lock)')
    }
  }
  if (entryExists(lockPathFor(statePath))) {
    fail('attempt lock held by another recoverer')
  }
  if (!acquireLock(statePath, record, owner, pid)) {
    fail('attempt lock held by another recoverer')
  }

  record.state = 'in_attempt'
  record.owner = owner
  record.attempts_started += 1
  pushHistory(record, 'begin_attempt', { owner, pid })
  saveState(statePath, record)
  return { status: 'attempt_started', delivery_id: record.delivery_id, owner, attempt: record.attempts_started }
}

function recordResult(options) {
  const statePath = options.state
  const now = options._now
  const owner = options.owner
  const ownerPid = parseInteger(options['owner-pid'], 'owner-pid')
  const result = options.result
  if (!RESULTS.has(result)) fail('result must be unsent, sent_unconfirmed, or confirmed')
  if (!options.evidence) fail('evidence must describe the observed UI result')
  if (result === 'confirmed') {
    if (options['observed-message'] === undefined) {
      fail('confirming success requires --observed-message with the complete four-line message as one single real message')
    }
  }
  const draftPresent = options['draft-present'] === undefined
    ? false
    : options['draft-present'] === 'true'
  if (options['draft-present'] !== undefined && !['true', 'false'].includes(options['draft-present'])) {
    fail('draft-present must be true or false')
  }

  const record = loadState(statePath, now)
  const lock = readLock(statePath)
  if (!lock || lock.owner !== owner || lock.pid !== ownerPid) {
    fail('no attempt lock is held by this owner process')
  }
  if (record.state !== 'in_attempt') {
    if (TERMINAL_STATES.has(record.state) || record.state === 'needs_verification') {
      releaseLock(statePath, record, owner)
    }
    fail(`delivery is no longer in an attempt (state ${record.state})`)
  }

  const stopReason = authorityStopReason(record)
  if (stopReason) {
    record.state = 'stopped'
    record.owner = null
    record.last_error = { reason: stopReason, evidence: options.evidence, at: toIso(now) }
    pushHistory(record, 'stop', { reason: stopReason, evidence: options.evidence })
    saveState(statePath, record)
    releaseLock(statePath, record, owner)
    fail(`delivery authorization was revoked mid-attempt (${stopReason}); the record is retained as stopped`)
  }
  assertAuthorityLive(record)

  if (result === 'confirmed') {
    if (options['observed-message'] !== messageText(record.message.message_type, record.envelope.run_id, record.envelope.dispatch_id)) {
      fail('observed message does not match the complete canonical four-line callback of this delivery; a partial or split message is not a confirmed delivery')
    }
    record.state = 'confirmed'
    record.owner = null
    record.last_error = null
    pushHistory(record, 'record_result', { result, evidence: options.evidence, observed_message: 'exact single-message match' })
    saveState(statePath, record)
    releaseLock(statePath, record, owner)
    return { status: 'confirmed', delivery_id: record.delivery_id }
  }

  record.attempts += 1
  record.owner = null
  record.last_error = {
    at: toIso(now),
    result,
    evidence: options.evidence,
    draft_present: draftPresent,
    attempts: record.attempts,
  }
  pushHistory(record, 'record_result', {
    result,
    evidence: options.evidence,
    draft_present: draftPresent,
    attempts: record.attempts,
  })

  if (result === 'sent_unconfirmed') {
    record.state = 'needs_verification'
    record.eligible_since_ms = now
    record.verify_charge_pending = false
    saveState(statePath, record)
    releaseLock(statePath, record, owner)
    return { status: 'needs_verification', delivery_id: record.delivery_id, attempts: record.attempts }
  }

  if (!checkDeadline(record)) {
    saveState(statePath, record)
    releaseLock(statePath, record, owner)
    return { status: 'stopped', reason: 'delivery_deadline_expired' }
  }
  if (record.attempts >= record.policy.max_attempts) {
    record.state = 'parked'
    record.last_error.reason = 'attempt budget exhausted; durable pending record retained for manual review'
    pushHistory(record, 'park', { reason: 'attempt_budget_exhausted' })
    saveState(statePath, record)
    releaseLock(statePath, record, owner)
    return { status: 'parked', reason: 'attempt_budget_exhausted' }
  }

  record.state = 'waiting_backoff'
  record.eligible_since_ms = now
  const delay = backoffFor(record.attempts, record.policy)
  record.next_eligible_ms = now + delay
  record.next_eligible_at = toIso(record.next_eligible_ms)
  saveState(statePath, record)
  releaseLock(statePath, record, owner)
  return {
    status: 'waiting_backoff',
    attempts: record.attempts,
    next_eligible_at: record.next_eligible_at,
  }
}

function verify(options) {
  const statePath = options.state
  const now = options._now
  const owner = options.owner
  if (!['true', 'false'].includes(options.found)) fail('found must be true or false')
  const found = options.found === 'true'
  if (!options.evidence) fail('evidence must describe the read-only confirmation re-read')

  const record = loadState(statePath, now)
  if (record.state !== 'needs_verification') {
    fail(`verification requires needs_verification, not ${record.state}`)
  }
  assertAuthorityLive(record)
  assertFreshTargetCheck(options, record)

  const existingLock = readLock(statePath)
  if (existingLock) {
    const ownerPid = parseInteger(options['owner-pid'], 'owner-pid')
    if (existingLock.owner === owner && existingLock.pid === ownerPid) {
      // same owner process continues its verification
    } else if (!isPidAlive(existingLock.pid)) {
      // orphan lock on a non-attempt state guards nothing; discard with dead-pid proof
      unlinkSync(lockPathFor(statePath))
      fsyncDirectory(dirname(statePath))
      pushHistory(record, 'orphan_lock_discarded', { prior_owner: existingLock.owner })
      if (!acquireLock(statePath, record, owner, options._callerPid)) fail('attempt lock held by another recoverer')
    } else {
      fail(`attempt lock held by ${existingLock.owner}`)
    }
  } else if (!acquireLock(statePath, record, owner, options._callerPid)) {
    fail('attempt lock held by another recoverer')
  }

  if (found) {
    if (options['observed-message'] === undefined) {
      releaseLock(statePath, record, owner)
      fail('confirming presence requires --observed-message with the exact four lines of THIS dispatch')
    }
    if (options['observed-message'] !== messageText(record.message.message_type, record.envelope.run_id, record.envelope.dispatch_id)) {
      releaseLock(statePath, record, owner)
      fail('observed message does not match the bound delivery identity; re-read the exact four lines of THIS dispatch')
    }
    record.state = 'confirmed'
    record.last_error = null
    record.owner = null
    pushHistory(record, 'verify', { found, evidence: options.evidence })
    saveState(statePath, record)
    releaseLock(statePath, record, owner)
    return { status: 'confirmed', delivery_id: record.delivery_id }
  }

  pushHistory(record, 'verify', { found, evidence: options.evidence })
  if (record.verify_charge_pending) {
    record.attempts += 1
    record.verify_charge_pending = false
  }
  if (record.attempts >= record.policy.max_attempts) {
    record.state = 'parked'
    record.last_error = {
      at: toIso(now),
      reason: 'attempt budget exhausted; send outcome unverified, durable record retained for manual review',
    }
    pushHistory(record, 'park', { reason: 'attempt_budget_exhausted' })
    saveState(statePath, record)
    releaseLock(statePath, record, owner)
    return { status: 'parked', reason: 'attempt_budget_exhausted' }
  }
  if (now >= record.delivery_deadline_ms) {
    record.state = 'stopped'
    record.last_error = { reason: 'delivery_deadline_expired', at: toIso(now) }
    pushHistory(record, 'stop', { reason: 'delivery_deadline_expired' })
    saveState(statePath, record)
    releaseLock(statePath, record, owner)
    return { status: 'stopped', reason: 'delivery_deadline_expired' }
  }

  record.state = 'waiting_backoff'
  record.owner = null
  record.eligible_since_ms = now
  const delay = backoffFor(record.attempts, record.policy)
  record.next_eligible_ms = now + delay
  record.next_eligible_at = toIso(record.next_eligible_ms)
  saveState(statePath, record)
  releaseLock(statePath, record, owner)
  return { status: 'waiting_backoff', next_eligible_at: record.next_eligible_at }
}

function releaseAttempt(options) {
  const statePath = options.state
  const now = options._now
  const record = loadState(statePath, now)
  if (record.state !== 'in_attempt') fail(`delivery is not in an attempt (state ${record.state})`)
  releaseLock(statePath, record, options.owner)
  record.state = 'waiting_backoff'
  record.owner = null
  record.eligible_since_ms = now
  const delay = backoffFor(Math.max(record.attempts_started, 1), record.policy)
  record.next_eligible_ms = now + delay
  record.next_eligible_at = toIso(record.next_eligible_ms)
  pushHistory(record, 'release_attempt', { reason: options.reason })
  saveState(statePath, record)
  return { status: 'waiting_backoff', next_eligible_at: record.next_eligible_at }
}

function reclaimStaleLock(options) {
  const statePath = options.state
  const now = options._now
  const record = loadState(statePath, now)
  if (record.state !== 'in_attempt') fail(`delivery is not in an attempt (state ${record.state})`)
  const lock = readLock(statePath)
  if (!lock) fail('no attempt lock exists to reclaim')
  if (lock.owner !== options['prior-owner']) {
    fail('attempt lock owner does not match --prior-owner')
  }
  if (isPidAlive(lock.pid)) fail('cannot reclaim: the prior owner process is still alive')
  if (options.owner === lock.owner) fail('the reclaiming owner must differ from the prior owner')

  unlinkSync(lockPathFor(statePath))
  fsyncDirectory(dirname(statePath))
  record.state = 'needs_verification'
  record.owner = null
  record.eligible_since_ms = now
  record.verify_charge_pending = true
  pushHistory(record, 'lock_reclaimed', {
    prior_owner: lock.owner,
    prior_pid: lock.pid,
    evidence: options.evidence,
  })
  saveState(statePath, record)
  return { status: 'reclaimed', prior_owner: lock.owner, state: record.state }
}

function recordStop(options) {
  const statePath = options.state
  const now = options._now
  const reason = options.reason
  if (!STOP_REASONS.has(reason)) {
    fail('reason must be delivery_deadline_expired, run_cancelled, coordinator_handled, or target_mismatch')
  }
  const record = loadState(statePath, now)
  if (TERMINAL_STATES.has(record.state)) fail(`delivery is already terminal (state ${record.state})`)
  record.state = 'stopped'
  record.owner = null
  record.last_error = { reason, evidence: options.evidence, at: toIso(now) }
  pushHistory(record, 'stop', { reason, evidence: options.evidence })
  saveState(statePath, record)
  const lock = readLock(statePath)
  if (lock && (options.owner === lock.owner || !isPidAlive(lock.pid))) {
    unlinkSync(lockPathFor(statePath))
    fsyncDirectory(dirname(statePath))
  }
  return { status: 'stopped', reason }
}

function status(options) {
  const now = options._now
  const record = loadState(options.state, now)
  const lock = readLock(options.state)
  return {
    delivery_id: record.delivery_id,
    state: record.state,
    attempts: record.attempts,
    attempts_started: record.attempts_started,
    max_attempts: record.policy.max_attempts,
    next_eligible_at: record.next_eligible_at,
    delivery_deadline: record.delivery_deadline,
    remaining_ms: Math.max(record.delivery_deadline_ms - now, 0),
    recommended_action: recommendedActionFor(record),
    last_error: record.last_error,
    lock: lock
      ? { owner: lock.owner, pid: lock.pid, lease_expires_at: lock.lease_expires_at }
      : null,
    message_type: record.message.message_type,
    message_text: messageText(record.message.message_type, record.envelope.run_id, record.envelope.dispatch_id),
    history: record.history.slice(-10),
    updated_at: record.updated_at,
  }
}

function renderMessage(options) {
  const record = loadState(options.state, options._now)
  return {
    message_type: record.message.message_type,
    message_text: messageText(record.message.message_type, record.envelope.run_id, record.envelope.dispatch_id),
  }
}

// Recovery backfill for the release→enqueue crash window: the worker may die
// after releasing the receipt but before any pending record exists. The next
// explicitly authorized recovery rebuilds ONE record from the trusted
// dispatch information and the terminal receipt; it never re-releases, never
// reruns work, and never invents a delivery deadline. Old envelopes without an
// authorized deadline are handled conservatively: refused with the reason
// retained, no permission expanded. Existing records can never be re-deadlined
// or re-identified by new parameters (enqueue identity comparison).
function recover(options) {
  if (!options['delivery-deadline']) {
    // The refusal must outlive this process: persist the reason as a durable
    // sidecar (no send permission is created) instead of only printing it.
    const stateDir = options['state-dir']
    const runId = options['run-id']
    const dispatchId = options['dispatch-id']
    if (typeof stateDir === 'string' && stateDir.length > 0
      && UUID.test(runId) && UUID.test(dispatchId)) {
      const notePath = `${stateDir}/${runId}.${dispatchId}.recovery-blocked.json`
      atomicWriteJson(stateDir, notePath, {
        protocol: PROTOCOL,
        delivery_id: `${runId}.${dispatchId}`,
        status: 'recovery_blocked',
        reason: 'delivery deadline must be explicitly authorized for recovery; a missing deadline is never invented',
        at: toIso(options._now),
      })
      fail('delivery deadline must be explicitly authorized for recovery; a missing deadline is never invented (reason persisted at ' + notePath + ')')
    }
    fail('delivery deadline must be explicitly authorized for recovery; a missing deadline is never invented')
  }
  return enqueue({ ...options, _recover: true })
}

const LOCATION_BLOCK_LIMIT = 8
const BUDGET_RECORD_VERSION = 2
const LOCATION_BLOCKS_MAX = 1000000

// Zero-send diagnostics: every observed UI blocker (anchor not located, window
// conflict, draft occupied, ...) is persisted against the record even when no
// attempt ever started, so attempts=0 still explains itself. Location retries
// are bounded: past LOCATION_BLOCK_LIMIT observations of the same reason the
// record stops with location_budget_exhausted instead of looping forever.
// This records observations only; it never fabricates a target-verified
// attestation and never authorizes a send by itself.
function noteBlock(options) {
  const statePath = options.state
  const now = options._now
  const reason = options.reason
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 64) {
    fail('note-block reason must be a short non-empty string')
  }
  const record = loadState(statePath, now)
  // Diagnostics are never a state or ownership transition entry point: live
  // attempts (and their locks) and unresolved send uncertainty are left
  // exactly as they are, and the observation is a no-op.
  if (TERMINAL_STATES.has(record.state) || record.state === 'in_attempt'
    || record.state === 'needs_verification') {
    return {
      status: record.state,
      reason,
      attempts: record.attempts,
      recorded: false,
      note: 'diagnostic ignored; send-state transitions belong to their own commands',
    }
  }
  const lock = readLock(statePath)
  if (lock) {
    return {
      status: record.state,
      reason,
      attempts: record.attempts,
      recorded: false,
      note: 'diagnostic ignored while an attempt lock exists',
    }
  }
  // Past the delivery deadline there is no re-delivery permission left to
  // spend: stop durably instead of staying queued forever.
  if (now >= record.delivery_deadline_ms) {
    record.state = 'stopped'
    record.owner = null
    record.last_error = {
      reason: 'delivery_deadline_expired',
      evidence: 'location note observed after the delivery deadline; no re-delivery permission remains',
      at: toIso(now),
    }
    pushHistory(record, 'stop', { reason: 'delivery_deadline_expired' })
    saveState(statePath, record)
    return { status: record.state, reason, attempts: record.attempts }
  }
  // Legacy records predate the durable counter: their location history can
  // never be proven complete (bounded history may have evicted failures), so
  // the honest checkpoint is a conservative stop with a retained reason —
  // never an inferred remaining budget and never a silently repaired counter.
  if (record.record_version !== BUDGET_RECORD_VERSION || !Number.isSafeInteger(record.location_blocks_total)) {
    record.state = 'stopped'
    record.owner = null
    record.last_error = {
      reason: 'legacy_location_budget_unknown',
      evidence: 'record predates the durable location budget; its full history cannot be proven, so further location retries stop at this explainable checkpoint until a new explicitly authorized record is created',
      at: toIso(now),
    }
    pushHistory(record, 'stop', { reason: 'legacy_location_budget_unknown' })
    saveState(statePath, record)
    return { status: record.state, reason: 'legacy_location_budget_unknown', attempts: record.attempts }
  }
  // Versioned records: the durable counter survives history trimming, reason
  // rotation, and worker restarts; schema validation has already refused any
  // malformed or over-bounds value without touching the bytes.
  record.location_blocks_total += 1
  pushHistory(record, 'location_blocked', { reason, evidence: options.evidence, attempts: record.attempts })
  if (record.location_blocks_total >= LOCATION_BLOCK_LIMIT) {
    record.state = 'stopped'
    record.owner = null
    record.last_error = {
      reason: 'location_budget_exhausted',
      evidence: 'location failures observed ' + record.location_blocks_total + ' times (durable counter, zero sends); recovery stays available only via a new explicitly authorized session',
      at: toIso(now),
    }
    pushHistory(record, 'stop', { reason: 'location_budget_exhausted' })
  }
  saveState(statePath, record)
  return { status: record.state, reason, location_blocks_total: record.location_blocks_total, attempts: record.attempts }
}

function runCommand(command, options) {
  if (command === 'recover') return recover(options)
  if (command === 'note-block') return noteBlock(options)
  if (command === 'enqueue') return enqueue(options)
  if (command === 'status') return status(options)
  if (command === 'begin-attempt') return beginAttempt({ ...options, _callerPid: process.pid })
  if (command === 'record-result') return recordResult(options)
  if (command === 'verify') return verify({ ...options, _callerPid: process.pid })
  if (command === 'release-attempt') return releaseAttempt(options)
  if (command === 'reclaim-stale-lock') return reclaimStaleLock(options)
  if (command === 'record-stop') return recordStop(options)
  if (command === 'render-message') return renderMessage(options)
  fail(`unhandled command ${command}`)
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  options._now = options.now === undefined ? Date.now() : parseMs(options.now, 'now')
  let result
  if (command === 'status' || command === 'render-message') {
    result = runCommand(command, options)
  } else {
    const stateForMutex = command === 'enqueue' || command === 'recover'
      ? `${options['state-dir']}/${options['run-id']}.${options['dispatch-id']}.pending.json`
      : options.state
    result = withStateMutex(stateForMutex, () => runCommand(command, options))
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`)
  process.exitCode = 1
}
