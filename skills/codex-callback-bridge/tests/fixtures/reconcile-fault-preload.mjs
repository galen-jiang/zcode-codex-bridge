// Test-only fault injection for ReconcileLockRepair coverage. Runs via
// `node --import` ahead of the candidate entry, only against an isolated
// temporary fixture root; it never touches the candidate sources or any real
// run, and grants no production bypass.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir as osTmpdir } from 'node:os'

const root = process.env.RECONCILE_FAULT_ROOT
const mode = process.env.RECONCILE_FAULT_MODE ?? 'ledger_open_eacces'
if (!root?.startsWith(join(osTmpdir(), 'recovery-fault-'))) {
  throw Error('Only independent temporary fixtures are allowed')
}

const originalOpen = fs.openSync
const originalWriteFile = fs.writeFileSync
const originalRename = fs.renameSync
const originalFsync = fs.fsyncSync
let injected = false
let holderFd = null
let ledgerRenamed = false

fs.openSync = function (path, ...args) {
  if (mode === 'owner_swap' && holderFd === null && typeof path === 'string' && path.endsWith('/holder.json')) {
    holderFd = originalOpen.call(this, path, ...args)
    return holderFd
  }
  return originalOpen.call(this, path, ...args)
}

fs.writeFileSync = function (fd, data, ...args) {
  if (mode === 'owner_swap' && !injected && holderFd !== null && fd === holderFd) {
    injected = true
    const swapped = String(data).replace(
      /"holder_id": "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/,
      '"holder_id": "00000000-0000-4000-8000-000000000000"',
    )
    return originalWriteFile.call(this, fd, swapped, ...args)
  }
  return originalWriteFile.call(this, fd, data, ...args)
}

if (mode === 'ledger_open_eacces') {
  fs.openSync = function (path, ...args) {
    if (!injected && typeof path === 'string'
      && path.startsWith(root + '/zcode-runs/.reconcile.') && path.endsWith('.tmp')) {
      injected = true
      const error = new Error('TEST_INJECTED_EACCES_BEFORE_LEDGER_WRITE')
      error.code = 'EACCES'
      throw error
    }
    return originalOpen.call(this, path, ...args)
  }
}

if (mode === 'state_fsync_after_rename') {
  fs.renameSync = function (from, to) {
    const result = originalRename.call(this, from, to)
    if (typeof to === 'string' && to.startsWith(root + '/zcode-runs/')
      && to.endsWith('.json') && !to.endsWith('.tmp')) {
      ledgerRenamed = true
    }
    return result
  }
  fs.fsyncSync = function (fd) {
    if (!injected && ledgerRenamed) {
      injected = true
      const error = new Error('TEST_INJECTED_FSYNC_FAILURE_AFTER_LEDGER_RENAME')
      error.code = 'EIO'
      throw error
    }
    return originalFsync.call(this, fd)
  }
}

syncBuiltinESMExports()
