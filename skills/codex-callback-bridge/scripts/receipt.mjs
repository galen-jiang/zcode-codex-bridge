#!/usr/bin/env node

import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
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
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const [command, ...tokens] = argv
  if (!['claim', 'assert-active', 'release'].includes(command)) {
    fail('usage: receipt.mjs <claim|assert-active|release> --ledger PATH --tombstone PATH --receiver PATH --run-id ID --dispatch-id ID --coordinator-task-id ID --stop-at RFC3339')
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

  const allowed = new Set([
    'ledger',
    'tombstone',
    'receiver',
    'run-id',
    'dispatch-id',
    'coordinator-task-id',
    'stop-at',
    'receiver-id',
    'outcome',
    'reason',
  ])
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail(`unknown argument --${key}`)
  }
  for (const key of [
    'ledger',
    'tombstone',
    'receiver',
    'run-id',
    'dispatch-id',
    'coordinator-task-id',
    'stop-at',
  ]) {
    if (!options[key]) fail(`missing required argument --${key}`)
  }
  if (command !== 'claim' && !options['receiver-id']) {
    fail('missing required argument --receiver-id')
  }
  if (command === 'release' && !OUTCOMES.has(options.outcome)) {
    fail('release outcome must be completed, blocked, or needs_decision')
  }

  return { command, options }
}

function validatePaths(options) {
  const paths = {
    ledger: options.ledger,
    tombstone: options.tombstone,
    receiver: options.receiver,
  }
  for (const [name, path] of Object.entries(paths)) {
    if (!isAbsolute(path) || resolve(path) !== path) {
      fail(`${name} path must be absolute and normalized`)
    }
  }

  const runId = options['run-id']
  const dispatchId = options['dispatch-id']
  const coordinatorTaskId = options['coordinator-task-id']
  const stopAt = options['stop-at']
  if (!UUID.test(runId)) fail('run-id must be a lowercase UUID')
  if (!UUID.test(dispatchId)) fail('dispatch-id must be a lowercase UUID')
  if (options['receiver-id'] && !UUID.test(options['receiver-id'])) {
    fail('receiver-id must be a lowercase UUID')
  }
  if (!RFC3339.test(stopAt) || !Number.isFinite(Date.parse(stopAt))) {
    fail('stop-at must be an RFC 3339 timestamp with an offset')
  }
  if (basename(paths.ledger) !== `${runId}.json`) {
    fail('ledger path does not match run ID')
  }
  if (basename(paths.tombstone) !== `${runId}.tombstone`) {
    fail('tombstone path does not match run ID')
  }
  if (basename(paths.receiver) !== `${runId}.${dispatchId}.receiver`) {
    fail('receiver path does not match run and dispatch IDs')
  }

  const parent = dirname(paths.ledger)
  if (dirname(paths.tombstone) !== parent || dirname(paths.receiver) !== parent) {
    fail('ledger, tombstone, and receiver must share one state directory')
  }
  if (basename(parent) !== 'zcode-runs') {
    fail('state directory must be named zcode-runs')
  }
  const parentStat = lstatSync(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail('state directory must be a real directory')
  }

  return {
    ...paths,
    parent,
    runId,
    dispatchId,
    coordinatorTaskId,
    stopAt,
    stopAtMs: Date.parse(stopAt),
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

function assertDispatchLive(paths) {
  if (entryExists(paths.tombstone)) fail('tombstone exists')
  const ledger = readJsonFile(paths.ledger, 'ledger', MAX_LEDGER_BYTES)
  if (
    ledger.run_id !== paths.runId
    || ledger.status !== 'dispatched'
    || ledger.outstanding_dispatch_id !== paths.dispatchId
    || ledger.attempt?.dispatch_id !== paths.dispatchId
  ) {
    fail('ledger is not the outstanding dispatched attempt')
  }
  if (ledger.attempt.receiver_receipt_path !== paths.receiver) {
    fail('ledger receiver path does not match the envelope')
  }
  if (
    ledger.coordinator?.task_id !== paths.coordinatorTaskId
    || ledger.attempt_limits?.stop_at !== paths.stopAt
  ) {
    fail('ledger coordinator or stop_at does not match the envelope')
  }
  if (Date.now() >= paths.stopAtMs) fail('dispatch stop_at has passed')
  if (entryExists(paths.tombstone)) fail('tombstone exists')
  return ledger
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
  const temporary = `${directory}/.receipt.${randomUUID()}.tmp`
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

function receiptPath(paths) {
  return `${paths.receiver}/receipt.json`
}

function transitionLockPath(paths) {
  return `${paths.receiver}/.transition.lock`
}

function withTransitionLock(paths, work) {
  const lock = transitionLockPath(paths)
  try {
    mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') fail('receipt transition is already in progress')
    throw error
  }
  fsyncDirectory(paths.receiver)

  let result
  let workError
  try {
    result = work()
  } catch (error) {
    workError = error
  }

  try {
    rmdirSync(lock)
    fsyncDirectory(paths.receiver)
  } catch (cleanupError) {
    if (!workError) throw cleanupError
  }
  if (workError) throw workError
  return result
}

function readActiveReceipt(paths, receiverId) {
  const receipt = readJsonFile(receiptPath(paths), 'receipt', MAX_RECEIPT_BYTES)
  if (
    receipt.protocol !== RECEIPT_PROTOCOL
    || receipt.run_id !== paths.runId
    || receipt.dispatch_id !== paths.dispatchId
    || receipt.coordinator_task_id !== paths.coordinatorTaskId
    || receipt.stop_at !== paths.stopAt
    || receipt.receiver_id !== receiverId
    || receipt.status !== 'active'
  ) {
    fail('active receipt identity mismatch')
  }
  return receipt
}

function claim(paths) {
  assertDispatchLive(paths)
  mkdirSync(paths.receiver, { mode: 0o700 })
  fsyncDirectory(paths.parent)

  const receipt = {
    protocol: RECEIPT_PROTOCOL,
    run_id: paths.runId,
    dispatch_id: paths.dispatchId,
    coordinator_task_id: paths.coordinatorTaskId,
    stop_at: paths.stopAt,
    receiver_id: randomUUID(),
    status: 'active',
    created_at: new Date().toISOString(),
  }

  // The directory is an irreversible claim. Any partial claim stays behind as
  // fail-closed evidence, so failures below intentionally have no cleanup path.
  return withTransitionLock(paths, () => {
    atomicWriteJson(paths.receiver, receiptPath(paths), receipt)
    try {
      assertDispatchLive(paths)
    } catch (error) {
      atomicWriteJson(paths.receiver, receiptPath(paths), {
        ...receipt,
        status: 'abandoned',
        reason: error.message,
        abandoned_at: new Date().toISOString(),
      })
      throw error
    }
    return receipt
  })
}

function assertActive(paths, receiverId) {
  if (entryExists(transitionLockPath(paths))) fail('receipt transition is already in progress')
  assertDispatchLive(paths)
  const receipt = readActiveReceipt(paths, receiverId)
  assertDispatchLive(paths)
  if (entryExists(transitionLockPath(paths))) fail('receipt transition is already in progress')
  return receipt
}

function release(paths, receiverId, outcome, reason) {
  return withTransitionLock(paths, () => {
    const receipt = readActiveReceipt(paths, receiverId)
    const released = {
      ...receipt,
      status: 'released',
      outcome,
      ...(reason === undefined ? {} : { reason }),
      released_at: new Date().toISOString(),
    }
    atomicWriteJson(paths.receiver, receiptPath(paths), released)
    return released
  })
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  const paths = validatePaths(options)
  let result
  if (command === 'claim') result = claim(paths)
  if (command === 'assert-active') result = assertActive(paths, options['receiver-id'])
  if (command === 'release') {
    result = release(
      paths,
      options['receiver-id'],
      options.outcome,
      options.reason,
    )
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`)
  process.exitCode = 1
}
