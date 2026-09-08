import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

const [command, rawConfig] = process.argv.slice(2)
if (!command || !rawConfig)
  throw new TypeError('usage: coordinator-run-v1.mjs <command> <json-config>')

const config = JSON.parse(rawConfig)
// State directory resolution: explicit config.stateDir wins, then the
// CODEX_BRIDGE_STATE_DIR environment variable, then the homedir default.
// Every source is validated the same way; an invalid explicit value is
// rejected instead of silently falling back.
const defaultStateDir = join(homedir(), '.codex', 'state', 'zcode-runs')
const explicitStateDir = Object.hasOwn(config, 'stateDir') ? config.stateDir : process.env.CODEX_BRIDGE_STATE_DIR
const stateDir = (() => {
  const candidate = explicitStateDir === undefined ? defaultStateDir : explicitStateDir
  if (typeof candidate !== 'string'
    || resolve(candidate) !== candidate
    || basename(candidate) !== 'zcode-runs')
    throw new TypeError('stateDir must be an absolute normalized zcode-runs directory')
  return candidate
})()

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

const canonicalBytes = value => Buffer.from(`${JSON.stringify(canonicalize(value))}\n`)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const assertUuid = (value, label) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw new TypeError(`${label} must be a lowercase UUID`)
}

const assertRelativeFile = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\'))
    throw new TypeError(`invalid relative POSIX path: ${value}`)
  const normalized = posix.normalize(value)
  if (normalized !== value || normalized === '..' || normalized.startsWith('../'))
    throw new TypeError(`unsafe relative POSIX path: ${value}`)
}

const fsyncFile = async path => {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

const fsyncDir = async path => {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

const writeNewFile = async (path, bytes, mode = 0o600) => {
  const handle = await open(path, 'wx', mode)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const atomicCreate = async (path, bytes, mode = 0o600) => {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  await writeNewFile(temporary, bytes, mode)
  try {
    await link(temporary, path)
    await fsyncDir(directory)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

const atomicReplace = async (path, bytes, mode = 0o600) => {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  await writeNewFile(temporary, bytes, mode)
  await rename(temporary, path)
  await chmod(path, mode)
  await fsyncDir(directory)
}

const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: null,
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8') ?? ''
    throw new Error(`${executable} ${args.join(' ')} failed (${result.status}): ${stderr}`)
  }
  return result.stdout ?? Buffer.alloc(0)
}

const git = (worktree, args) => run('git', args, { cwd: worktree })

const liveState = worktree => {
  const head = git(worktree, ['rev-parse', 'HEAD']).toString('utf8').trim()
  const branch = git(worktree, ['branch', '--show-current']).toString('utf8').trim()
  const status = git(worktree, ['status', '--short', '--untracked-files=all']).toString('utf8').replace(/\n$/, '')
  const staged = git(worktree, ['diff', '--cached', '--binary', '--no-textconv', '--no-ext-diff'])
  const unstaged = git(worktree, ['diff', '--binary', '--no-textconv', '--no-ext-diff'])
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean).sort()
  return { head, branch, status, staged, unstaged, untracked }
}

const assertExpectedLiveState = (state, expected) => {
  if (state.head !== expected.head) throw new Error(`HEAD mismatch: ${state.head}`)
  if (state.branch !== expected.branch) throw new Error(`branch mismatch: ${state.branch}`)
  const allowed = [...expected.allowedUntracked].sort()
  if (JSON.stringify(state.untracked) !== JSON.stringify(allowed))
    throw new Error(`untracked mismatch: ${JSON.stringify(state.untracked)}`)
  if (state.staged.length !== 0) throw new Error('staged patch must be empty for this accepted baseline')
  if (Object.hasOwn(expected, 'status') && state.status !== expected.status)
    throw new Error('live status differs from reviewed baseline')
  if (Object.hasOwn(expected, 'unstagedSha256')) {
    if (sha256(state.unstaged) !== expected.unstagedSha256)
      throw new Error('tracked unstaged patch differs from reviewed baseline')
  } else if (state.unstaged.length !== 0) {
    throw new Error('tracked unstaged patch must be empty for this accepted baseline')
  }
}

const verifySnapshotDirectory = async (root, expectedManifestSha) => {
  const manifestPath = join(root, 'manifest.json')
  const manifestBytes = await readFile(manifestPath)
  if (sha256(manifestBytes) !== expectedManifestSha) throw new Error('manifest digest mismatch')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))

  for (const [kind, entry] of Object.entries(manifest.patches)) {
    if (!['staged', 'unstaged'].includes(kind) || entry.archive_path !== `${kind}.patch`)
      throw new Error(`invalid patch manifest entry: ${kind}`)
    const bytes = await readFile(join(root, entry.archive_path))
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
      throw new Error(`patch verification failed: ${entry.archive_path}`)
  }
  for (const entry of manifest.untracked) {
    assertRelativeFile(entry.path)
    if (entry.type !== 'file' || entry.archive_path !== `untracked/${entry.path}`)
      throw new Error(`invalid untracked manifest entry: ${entry.path}`)
    const filePath = join(root, ...entry.archive_path.split('/'))
    const stat = await lstat(filePath)
    const bytes = await readFile(filePath)
    if (!stat.isFile() || bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
      throw new Error(`untracked verification failed: ${entry.path}`)
  }
  return manifest
}

const assertManifestMatchesReviewedState = ({
  manifest,
  state,
  worktree,
  expectedUnstagedSha256,
  expectedUntrackedSha256,
}) => {
  if (manifest.protocol !== 'zcode-accepted-baseline/v1'
    || manifest.metadata.head !== state.head
    || manifest.metadata.branch !== state.branch
    || manifest.metadata.status !== state.status
    || manifest.metadata.worktree !== worktree) {
    throw new Error('snapshot manifest metadata does not match reviewed state')
  }
  for (const [kind, bytes] of [['staged', state.staged], ['unstaged', state.unstaged]]) {
    const entry = manifest.patches[kind]
    if (entry.size !== bytes.length || entry.sha256 !== sha256(bytes))
      throw new Error(`${kind} snapshot patch does not match reviewed state`)
  }
  if (manifest.patches.unstaged.sha256 !== expectedUnstagedSha256)
    throw new Error('snapshot unstaged digest does not match reviewed digest')

  const expectedPaths = Object.keys(expectedUntrackedSha256).sort()
  const manifestPaths = manifest.untracked.map(entry => entry.path).sort()
  if (JSON.stringify(manifestPaths) !== JSON.stringify(expectedPaths))
    throw new Error('snapshot untracked digest paths do not match reviewed paths')
  for (const entry of manifest.untracked) {
    if (entry.sha256 !== expectedUntrackedSha256[entry.path])
      throw new Error(`snapshot untracked digest does not match reviewed digest: ${entry.path}`)
  }
}

const adoptPublishedSnapshot = async ({
  archivePath,
  runId,
  label,
  worktree,
  state,
  expectedUnstagedSha256,
  expectedUntrackedSha256,
}) => {
  const archiveStat = await lstat(archivePath)
  if (!archiveStat.isFile()) throw new Error('published snapshot is not a regular file')
  const archiveBytes = await readFile(archivePath)
  const archiveSha = sha256(archiveBytes)
  const verifyRoot = await mkdtemp(join(stateDir, `.${runId}.${label}.adopt-`))
  try {
    run('tar', ['-xf', archivePath, '-C', verifyRoot], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const manifestBytes = await readFile(join(verifyRoot, 'manifest.json'))
    const manifestSha = sha256(manifestBytes)
    const manifest = await verifySnapshotDirectory(verifyRoot, manifestSha)
    if (canonicalBytes(manifest).compare(manifestBytes) !== 0)
      throw new Error('published snapshot manifest is not canonical')
    assertManifestMatchesReviewedState({
      manifest,
      state,
      worktree,
      expectedUnstagedSha256,
      expectedUntrackedSha256,
    })
    await assertLiveStateMatchesManifest(worktree, manifest)
    await chmod(archivePath, 0o400)
    await fsyncFile(archivePath)
    await fsyncDir(stateDir)
    const publishedBytes = await readFile(archivePath)
    if (sha256(publishedBytes) !== archiveSha) throw new Error('adopted archive digest changed during verification')
    return {
      baseline: {
        archive_sha256: archiveSha,
        head: manifest.metadata.head,
        manifest_sha256: manifestSha,
        snapshot_path: archivePath,
        status: manifest.metadata.status,
      },
      manifest,
    }
  } finally {
    await rm(verifyRoot, { recursive: true, force: true })
  }
}

const capturePublishedSnapshot = async ({
  runId,
  label,
  worktree,
  state,
  expectedUnstagedSha256,
  expectedUntrackedSha256,
}) => {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(label)) throw new TypeError('invalid snapshot label')
  const snapshotRoot = await mkdtemp(join(stateDir, `.${runId}.${label}.snapshot-`))
  const verifyRoot = await mkdtemp(join(stateDir, `.${runId}.${label}.verify-`))
  const temporaryArchive = join(stateDir, `.${runId}.${label}.${randomUUID()}.tar`)
  const finalArchive = join(stateDir, `${runId}.${label}.tar`)
  try {
    const stagedPath = join(snapshotRoot, 'staged.patch')
    const unstagedPath = join(snapshotRoot, 'unstaged.patch')
    await writeNewFile(stagedPath, state.staged, 0o600)
    await writeNewFile(unstagedPath, state.unstaged, 0o600)

    const entries = []
    for (const relativePath of state.untracked) {
      const source = join(worktree, ...relativePath.split('/'))
      const sourceStat = await lstat(source)
      if (!sourceStat.isFile()) throw new Error(`untracked path is not a regular file: ${relativePath}`)
      const archivePath = `untracked/${relativePath}`
      const destination = join(snapshotRoot, ...archivePath.split('/'))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
      await chmod(destination, sourceStat.mode & 0o777)
      await fsyncFile(destination)
      const bytes = await readFile(destination)
      entries.push({
        archive_path: archivePath,
        mode: (sourceStat.mode & 0o777).toString(8).padStart(4, '0'),
        path: relativePath,
        sha256: sha256(bytes),
        size: bytes.length,
        type: 'file',
      })
    }

    const capturedAt = new Date().toISOString()
    const manifest = {
      metadata: {
        branch: state.branch,
        captured_at: capturedAt,
        head: state.head,
        status: state.status,
        worktree,
      },
      patches: {
        staged: { archive_path: 'staged.patch', sha256: sha256(state.staged), size: state.staged.length },
        unstaged: { archive_path: 'unstaged.patch', sha256: sha256(state.unstaged), size: state.unstaged.length },
      },
      protocol: 'zcode-accepted-baseline/v1',
      untracked: entries,
    }
    const manifestBytes = canonicalBytes(manifest)
    const manifestSha = sha256(manifestBytes)
    await writeNewFile(join(snapshotRoot, 'manifest.json'), manifestBytes, 0o600)
    await fsyncDir(snapshotRoot)

    run('tar', ['-cf', temporaryArchive, '-C', snapshotRoot, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    await fsyncFile(temporaryArchive)
    const archiveBytes = await readFile(temporaryArchive)
    const archiveSha = sha256(archiveBytes)
    run('tar', ['-xf', temporaryArchive, '-C', verifyRoot], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const verifiedManifest = await verifySnapshotDirectory(verifyRoot, manifestSha)
    if (canonicalBytes(verifiedManifest).compare(manifestBytes) !== 0)
      throw new Error('manifest canonical round-trip mismatch')

    assertManifestMatchesReviewedState({
      manifest,
      state,
      worktree,
      expectedUnstagedSha256,
      expectedUntrackedSha256,
    })

    try {
      await link(temporaryArchive, finalArchive)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      return await adoptPublishedSnapshot({
        archivePath: finalArchive,
        runId,
        label,
        worktree,
        state,
        expectedUnstagedSha256,
        expectedUntrackedSha256,
      })
    }
    await chmod(finalArchive, 0o400)
    await fsyncDir(stateDir)
    const publishedBytes = await readFile(finalArchive)
    if (sha256(publishedBytes) !== archiveSha) throw new Error('published archive digest mismatch')

    return {
      baseline: {
        archive_sha256: archiveSha,
        head: state.head,
        manifest_sha256: manifestSha,
        snapshot_path: finalArchive,
        status: state.status,
      },
      manifest,
    }
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true })
    await rm(verifyRoot, { recursive: true, force: true })
    await unlink(temporaryArchive).catch(() => {})
  }
}

const assertLiveStateMatchesManifest = async (worktree, manifest) => {
  const state = liveState(worktree)
  if (state.head !== manifest.metadata.head || state.branch !== manifest.metadata.branch || state.status !== manifest.metadata.status)
    throw new Error('live metadata changed after snapshot capture')
  for (const [kind, bytes] of [['staged', state.staged], ['unstaged', state.unstaged]]) {
    const expected = manifest.patches[kind]
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256)
      throw new Error(`${kind} patch changed after snapshot capture`)
  }
  const expectedPaths = manifest.untracked.map(entry => entry.path).sort()
  if (JSON.stringify(state.untracked) !== JSON.stringify(expectedPaths))
    throw new Error('untracked paths changed after snapshot capture')
  for (const entry of manifest.untracked) {
    const path = join(worktree, ...entry.path.split('/'))
    const stat = await lstat(path)
    const bytes = await readFile(path)
    if (!stat.isFile() || bytes.length !== entry.size || sha256(bytes) !== entry.sha256
      || (stat.mode & 0o777).toString(8).padStart(4, '0') !== entry.mode)
      throw new Error(`untracked file changed after snapshot capture: ${entry.path}`)
  }
}

const verifyPublishedBaselineAgainstLive = async ({ baseline, worktree }) => {
  const archivePath = baseline.snapshot_path
  const archiveStat = await lstat(archivePath)
  if (!archiveStat.isFile()) throw new Error('accepted baseline snapshot is not a regular file')
  const archiveBytes = await readFile(archivePath)
  if (sha256(archiveBytes) !== baseline.archive_sha256)
    throw new Error('accepted baseline archive digest mismatch')

  const verifyRoot = await mkdtemp(join(stateDir, '.baseline-live-verify-'))
  try {
    run('tar', ['-xf', archivePath, '-C', verifyRoot], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const manifestBytes = await readFile(join(verifyRoot, 'manifest.json'))
    if (sha256(manifestBytes) !== baseline.manifest_sha256)
      throw new Error('accepted baseline manifest digest mismatch')
    const manifest = await verifySnapshotDirectory(verifyRoot, baseline.manifest_sha256)
    if (canonicalBytes(manifest).compare(manifestBytes) !== 0)
      throw new Error('accepted baseline manifest is not canonical')
    if (manifest.metadata.head !== baseline.head
      || manifest.metadata.status !== baseline.status
      || manifest.metadata.worktree !== worktree) {
      throw new Error('accepted baseline metadata mismatch')
    }
    await assertLiveStateMatchesManifest(worktree, manifest)
  } finally {
    await rm(verifyRoot, { recursive: true, force: true })
  }
}

const verifyPublishedBaselineSubsetOfLive = async ({ baseline, worktree, extraUntracked }) => {
  const archivePath = baseline.snapshot_path
  const archiveStat = await lstat(archivePath)
  if (!archiveStat.isFile()) throw new Error('accepted baseline snapshot is not a regular file')
  const archiveBytes = await readFile(archivePath)
  if (sha256(archiveBytes) !== baseline.archive_sha256)
    throw new Error('accepted baseline archive digest mismatch')

  const verifyRoot = await mkdtemp(join(stateDir, '.baseline-subset-verify-'))
  try {
    run('tar', ['-xf', archivePath, '-C', verifyRoot], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const manifestBytes = await readFile(join(verifyRoot, 'manifest.json'))
    if (sha256(manifestBytes) !== baseline.manifest_sha256)
      throw new Error('accepted baseline manifest digest mismatch')
    const manifest = await verifySnapshotDirectory(verifyRoot, baseline.manifest_sha256)
    if (canonicalBytes(manifest).compare(manifestBytes) !== 0)
      throw new Error('accepted baseline manifest is not canonical')
    if (manifest.metadata.head !== baseline.head
      || manifest.metadata.status !== baseline.status
      || manifest.metadata.worktree !== worktree) {
      throw new Error('accepted baseline metadata mismatch')
    }

    const state = liveState(worktree)
    if (state.head !== manifest.metadata.head || state.branch !== manifest.metadata.branch)
      throw new Error('live HEAD or branch differs from accepted baseline')
    for (const [kind, bytes] of [['staged', state.staged], ['unstaged', state.unstaged]]) {
      const expected = manifest.patches[kind]
      if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256)
        throw new Error(`${kind} patch differs from accepted baseline`)
    }
    const baselinePaths = manifest.untracked.map(entry => entry.path).sort()
    const authorizedPaths = new Set(extraUntracked)
    const expectedPaths = [...new Set([...baselinePaths, ...extraUntracked])].sort()
    if (JSON.stringify(state.untracked) !== JSON.stringify(expectedPaths))
      throw new Error('live untracked paths differ from accepted baseline plus authorized WIP')
    for (const entry of manifest.untracked) {
      if (authorizedPaths.has(entry.path)) continue
      const filePath = join(worktree, ...entry.path.split('/'))
      const stat = await lstat(filePath)
      const bytes = await readFile(filePath)
      if (!stat.isFile() || bytes.length !== entry.size || sha256(bytes) !== entry.sha256
        || (stat.mode & 0o777).toString(8).padStart(4, '0') !== entry.mode) {
        throw new Error(`accepted baseline file changed: ${entry.path}`)
      }
    }
  } finally {
    await rm(verifyRoot, { recursive: true, force: true })
  }
}

const createSnapshotAndLedger = async () => {
  assertUuid(config.runId, 'runId')
  if (!Array.isArray(config.approvedTasks) || config.approvedTasks.length === 0
    || config.approvedTasks.some(task => typeof task !== 'string' || task.length === 0))
    throw new TypeError('approvedTasks must be a non-empty string array')
  if (new Set(config.approvedTasks).size !== config.approvedTasks.length)
    throw new Error('approvedTasks contains duplicates')
  if (config.currentTask !== config.approvedTasks[0])
    throw new Error('currentTask must be the first approved task')
  if (!Number.isSafeInteger(config.dispatchesMax) || config.dispatchesMax < 1
    || config.dispatchesMax > config.approvedTasks.length)
    throw new TypeError('dispatchesMax must cover a finite prefix of approvedTasks')
  if (!Number.isSafeInteger(config.repairsMaxPerTask) || config.repairsMaxPerTask < 0)
    throw new TypeError('repairsMaxPerTask must be a non-negative safe integer')
  if (typeof config.milestone !== 'string' || config.milestone.length === 0)
    throw new TypeError('milestone must be a non-empty string')
  if (typeof config.zcodeProject !== 'string' || config.zcodeProject.length === 0)
    throw new TypeError('zcodeProject must be a non-empty string')
  const worktree = resolve(config.worktree)
  const expected = {
    head: config.expectedHead,
    branch: config.expectedBranch,
    allowedUntracked: config.allowedUntracked,
    status: config.expectedStatus,
    unstagedSha256: config.expectedUnstagedSha256,
  }
  for (const path of expected.allowedUntracked) assertRelativeFile(path)
  if (new Set(expected.allowedUntracked).size !== expected.allowedUntracked.length)
    throw new Error('allowedUntracked contains duplicates')

  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const state = liveState(worktree)
  assertExpectedLiveState(state, expected)
  const expectedDigestPaths = Object.keys(config.expectedUntrackedSha256).sort()
  if (JSON.stringify(expectedDigestPaths) !== JSON.stringify([...expected.allowedUntracked].sort()))
    throw new Error('untracked digest paths do not exactly match the reviewed baseline')
  for (const [relativePath, expectedSha] of Object.entries(config.expectedUntrackedSha256)) {
    const bytes = await readFile(join(worktree, ...relativePath.split('/')))
    if (sha256(bytes) !== expectedSha)
      throw new Error(`untracked digest differs from reviewed baseline: ${relativePath}`)
  }

  const snapshotRoot = await mkdtemp(join(stateDir, `.${config.runId}.snapshot-`))
  const verifyRoot = await mkdtemp(join(stateDir, `.${config.runId}.verify-`))
  const temporaryArchive = join(stateDir, `.${config.runId}.${randomUUID()}.tar`)
  const finalArchive = join(stateDir, `${config.runId}.baseline.tar`)
  try {
    const stagedPath = join(snapshotRoot, 'staged.patch')
    const unstagedPath = join(snapshotRoot, 'unstaged.patch')
    await writeNewFile(stagedPath, state.staged, 0o600)
    await writeNewFile(unstagedPath, state.unstaged, 0o600)

    const entries = []
    for (const relativePath of state.untracked) {
      const source = join(worktree, ...relativePath.split('/'))
      const sourceStat = await lstat(source)
      if (!sourceStat.isFile()) throw new Error(`untracked path is not a regular file: ${relativePath}`)
      const archivePath = `untracked/${relativePath}`
      const destination = join(snapshotRoot, ...archivePath.split('/'))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
      await chmod(destination, sourceStat.mode & 0o777)
      await fsyncFile(destination)
      const bytes = await readFile(destination)
      entries.push({
        archive_path: archivePath,
        mode: (sourceStat.mode & 0o777).toString(8).padStart(4, '0'),
        path: relativePath,
        sha256: sha256(bytes),
        size: bytes.length,
        type: 'file',
      })
    }

    const capturedAt = new Date().toISOString()
    const manifest = {
      metadata: {
        branch: state.branch,
        captured_at: capturedAt,
        head: state.head,
        status: state.status,
        worktree,
      },
      patches: {
        staged: { archive_path: 'staged.patch', sha256: sha256(state.staged), size: state.staged.length },
        unstaged: { archive_path: 'unstaged.patch', sha256: sha256(state.unstaged), size: state.unstaged.length },
      },
      protocol: 'zcode-accepted-baseline/v1',
      untracked: entries,
    }
    const manifestBytes = canonicalBytes(manifest)
    const manifestSha = sha256(manifestBytes)
    await writeNewFile(join(snapshotRoot, 'manifest.json'), manifestBytes, 0o600)
    await fsyncDir(snapshotRoot)

    run('tar', ['-cf', temporaryArchive, '-C', snapshotRoot, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    await fsyncFile(temporaryArchive)
    const archiveBytes = await readFile(temporaryArchive)
    const archiveSha = sha256(archiveBytes)

    run('tar', ['-xf', temporaryArchive, '-C', verifyRoot], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const verifiedManifest = await verifySnapshotDirectory(verifyRoot, manifestSha)
    if (canonicalBytes(verifiedManifest).compare(manifestBytes) !== 0)
      throw new Error('manifest canonical round-trip mismatch')
    assertManifestMatchesReviewedState({
      manifest,
      state,
      worktree,
      expectedUnstagedSha256: config.expectedUnstagedSha256,
      expectedUntrackedSha256: config.expectedUntrackedSha256,
    })
    await assertLiveStateMatchesManifest(worktree, manifest)

    await link(temporaryArchive, finalArchive)
    await chmod(finalArchive, 0o400)
    await fsyncDir(stateDir)
    const publishedBytes = await readFile(finalArchive)
    if (sha256(publishedBytes) !== archiveSha) throw new Error('published archive digest mismatch')

    const ledger = {
      accepted_baseline: {
        archive_sha256: archiveSha,
        head: state.head,
        manifest_sha256: manifestSha,
        snapshot_path: finalArchive,
        status: state.status,
      },
      approved_tasks: config.approvedTasks,
      attempt: null,
      attempt_limits: null,
      branch: state.branch,
      brief_path: config.briefPath,
      coordinator: {
        project_id: config.coordinatorProjectId,
        project_label: config.coordinatorProjectLabel,
        task_id: config.coordinatorTaskId,
        task_title: config.coordinatorTaskTitle,
      },
      created_at: capturedAt,
      current_task: config.currentTask,
      dispatches: { max: config.dispatchesMax, used: 0 },
      finding_fingerprints: [],
      handled_dispatch_ids: [],
      last_verdict: null,
      message_type: null,
      milestone: config.milestone,
      outstanding_dispatch_id: null,
      repairs: Object.fromEntries(config.approvedTasks.map(task => [task, { max: config.repairsMaxPerTask, used: 0 }])),
      revision: 0,
      run_id: config.runId,
      spec_path: config.specPath,
      status: 'ready',
      stop_reason: null,
      task_cursor: 0,
      worktree,
      zcode: { model: config.zcodeModel, project: config.zcodeProject },
    }
    const ledgerPath = join(stateDir, `${config.runId}.json`)
    await atomicCreate(ledgerPath, canonicalBytes(ledger), 0o600)
    process.stdout.write(`${JSON.stringify({ archiveSha, ledgerPath, manifestSha, snapshotPath: finalArchive, status: state.status })}\n`)
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true })
    await rm(verifyRoot, { recursive: true, force: true })
    await unlink(temporaryArchive).catch(() => {})
  }
}

const createFromAuthorizedWip = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.sourceRunId, 'sourceRunId')
  if (config.runId === config.sourceRunId) throw new Error('new run must not reuse the stopped run id')
  if (!Array.isArray(config.approvedTasks) || config.approvedTasks.length === 0
    || config.approvedTasks.some(task => typeof task !== 'string' || task.length === 0))
    throw new TypeError('approvedTasks must be a non-empty string array')
  if (new Set(config.approvedTasks).size !== config.approvedTasks.length)
    throw new Error('approvedTasks contains duplicates')
  if (config.currentTask !== config.approvedTasks[0])
    throw new Error('currentTask must be the first approved task')
  if (!Number.isSafeInteger(config.dispatchesMax) || config.dispatchesMax < 1
    || config.dispatchesMax > config.approvedTasks.length)
    throw new TypeError('dispatchesMax must cover a finite prefix of approvedTasks')
  if (!Number.isSafeInteger(config.repairsMaxPerTask) || config.repairsMaxPerTask < 0)
    throw new TypeError('repairsMaxPerTask must be a non-negative safe integer')
  if (typeof config.userAuthorization !== 'string' || config.userAuthorization.length === 0)
    throw new TypeError('userAuthorization must be a non-empty string')
  if (typeof config.milestone !== 'string' || config.milestone.length === 0)
    throw new TypeError('milestone must be a non-empty string')
  if (typeof config.zcodeProject !== 'string' || config.zcodeProject.length === 0)
    throw new TypeError('zcodeProject must be a non-empty string')

  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const sourceLockPath = join(stateDir, `${config.sourceRunId}.lock`)
  await access(join(stateDir, `${config.sourceRunId}.tombstone`)).then(
    () => { throw new Error('source tombstone exists') },
    error => { if (error.code !== 'ENOENT') throw error },
  )
  await mkdir(sourceLockPath, { mode: 0o700 })
  const sourceHolderId = randomUUID()
  let source
  let sourceReceipt
  try {
    const sourceHolder = {
      acquired_at: new Date().toISOString(),
      acquired_at_revision: config.sourceRevision,
      coordinator_task_id: config.coordinatorTaskId,
      holder_id: sourceHolderId,
    }
    await writeNewFile(join(sourceLockPath, 'holder.json'), canonicalBytes(sourceHolder), 0o600)
    await fsyncDir(sourceLockPath)
    await fsyncDir(stateDir)
    await verifyHolder(config.sourceRunId, sourceHolderId, config.sourceRevision)

    source = await loadLedger(config.sourceRunId)
    if (source.status !== 'stopped' || source.revision !== config.sourceRevision
      || source.outstanding_dispatch_id !== null)
      throw new Error('source run is not the expected stopped checkpoint')
    if (source.coordinator.task_id !== config.coordinatorTaskId)
      throw new Error('source run coordinator mismatch')
    assertUuid(source.attempt?.dispatch_id, 'source attempt dispatch_id')
    sourceReceipt = await loadReleasedReceipt(source, source.attempt.dispatch_id)
    const isRejectedCompletion = sourceReceipt.outcome === 'completed'
      && source.last_verdict?.decision === 'rejected'
    const isHandledCheckpoint = ['blocked', 'needs_decision'].includes(sourceReceipt.outcome)
      && source.message_type === sourceReceipt.outcome
      && source.handled_dispatch_ids.includes(source.attempt.dispatch_id)
    if (!isRejectedCompletion && !isHandledCheckpoint)
      throw new Error('source run is neither a rejected completion nor a handled blocked checkpoint')

    const successorFence = {
      coordinator_task_id: config.coordinatorTaskId,
      created_at: new Date().toISOString(),
      protocol: 'zcode-successor-fence/v1',
      source_revision: source.revision,
      source_run_id: source.run_id,
      successor_run_id: config.runId,
    }
    const fencePath = join(stateDir, `${config.sourceRunId}.successor`)
    let existingFence = false
    await readFile(fencePath).then(
      bytes => {
        assertMatchingSuccessorFence(bytes, successorFence)
        existingFence = true
      },
      error => { if (error.code !== 'ENOENT') throw error },
    )

    const worktree = resolve(config.worktree)
    const expected = {
      head: config.expectedHead,
      branch: config.expectedBranch,
      allowedUntracked: config.allowedUntracked,
      status: config.expectedStatus,
      unstagedSha256: config.expectedUnstagedSha256,
    }
    for (const path of expected.allowedUntracked) assertRelativeFile(path)
    for (const path of config.authorizedWipPaths) assertRelativeFile(path)
    if (new Set(expected.allowedUntracked).size !== expected.allowedUntracked.length
      || new Set(config.authorizedWipPaths).size !== config.authorizedWipPaths.length)
      throw new Error('untracked path lists contain duplicates')
    const state = liveState(worktree)
    assertExpectedLiveState(state, expected)
    const expectedDigestPaths = Object.keys(config.expectedUntrackedSha256).sort()
    if (JSON.stringify(expectedDigestPaths) !== JSON.stringify([...expected.allowedUntracked].sort()))
      throw new Error('untracked digest paths do not exactly match the authorized WIP state')
    for (const [relativePath, expectedSha] of Object.entries(config.expectedUntrackedSha256)) {
      const bytes = await readFile(join(worktree, ...relativePath.split('/')))
      if (sha256(bytes) !== expectedSha)
        throw new Error(`untracked digest differs from authorized WIP state: ${relativePath}`)
    }
    await verifyPublishedBaselineSubsetOfLive({
      baseline: source.accepted_baseline,
      worktree,
      extraUntracked: [...config.authorizedWipPaths].sort(),
    })
    const { baseline: wipSnapshot, manifest } = await capturePublishedSnapshot({
      runId: config.runId,
      label: 'authorized-wip',
      worktree,
      state,
      expectedUnstagedSha256: config.expectedUnstagedSha256,
      expectedUntrackedSha256: config.expectedUntrackedSha256,
    })
    await assertLiveStateMatchesManifest(worktree, manifest)

    const createdAt = new Date().toISOString()
    const ledger = {
    accepted_baseline: source.accepted_baseline,
    approved_tasks: config.approvedTasks,
    attempt: null,
    attempt_limits: null,
    authorized_wip_input: {
      authorization: config.userAuthorization,
      paths: [...config.authorizedWipPaths].sort(),
      snapshot: wipSnapshot,
      source_revision: source.revision,
      source_run_id: source.run_id,
    },
    branch: state.branch,
    brief_path: config.briefPath,
    coordinator: {
      project_id: config.coordinatorProjectId,
      project_label: config.coordinatorProjectLabel,
      task_id: config.coordinatorTaskId,
      task_title: config.coordinatorTaskTitle,
    },
    created_at: createdAt,
    current_task: config.currentTask,
    dispatches: { max: config.dispatchesMax, used: 0 },
    finding_fingerprints: [...source.finding_fingerprints],
    handled_dispatch_ids: [],
    last_verdict: null,
    message_type: null,
    milestone: config.milestone,
    outstanding_dispatch_id: null,
    prior_checkpoint: {
      message_type: source.message_type,
      receipt_outcome: sourceReceipt.outcome,
      revision: source.revision,
      run_id: source.run_id,
      stop_reason: source.stop_reason,
    },
    prior_rejected_verdict: source.last_verdict ?? source.prior_rejected_verdict ?? null,
    repairs: Object.fromEntries(config.approvedTasks.map(task => [task, { max: config.repairsMaxPerTask, used: 0 }])),
    revision: 0,
    run_id: config.runId,
    spec_path: config.specPath,
    status: 'ready',
    stop_reason: null,
    task_cursor: 0,
    worktree,
    zcode: { model: config.zcodeModel, project: config.zcodeProject },
    }
    const ledgerPath = join(stateDir, `${config.runId}.json`)
    await atomicCreate(ledgerPath, canonicalBytes(ledger), 0o600)
    await verifyHolder(config.sourceRunId, sourceHolderId, config.sourceRevision)

    if (!existingFence) {
      try {
        await atomicCreate(fencePath, canonicalBytes(successorFence), 0o600)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        assertMatchingSuccessorFence(await readFile(fencePath), successorFence)
      }
    }
    await verifyHolder(config.sourceRunId, sourceHolderId, config.sourceRevision)
    process.stdout.write(`${JSON.stringify({ fencePath, ledgerPath, status: ledger.status, wipSnapshot })}\n`)
  } finally {
    await rm(sourceLockPath, { recursive: true, force: true })
    await fsyncDir(stateDir)
  }
}

const loadLedger = async runId => JSON.parse(await readFile(join(stateDir, `${runId}.json`), 'utf8'))

const verifyHolder = async (runId, holderId, expectedRevision) => {
  const lockPath = join(stateDir, `${runId}.lock`)
  const holder = JSON.parse(await readFile(join(lockPath, 'holder.json'), 'utf8'))
  if (holder.holder_id !== holderId || holder.coordinator_task_id !== config.coordinatorTaskId)
    throw new Error('lock holder mismatch')
  if (holder.acquired_at_revision > expectedRevision)
    throw new Error('lock acquired revision exceeds expected revision')
  await access(join(stateDir, `${runId}.tombstone`)).then(
    () => { throw new Error('tombstone exists') },
    error => { if (error.code !== 'ENOENT') throw error },
  )
  return { holder, lockPath }
}

const assertLedgerCas = (ledger, expected) => {
  if (ledger.coordinator.task_id !== config.coordinatorTaskId) throw new Error('coordinator mismatch')
  if (ledger.revision !== expected.revision) throw new Error(`revision mismatch: ${ledger.revision}`)
  if (ledger.status !== expected.status) throw new Error(`status mismatch: ${ledger.status}`)
  if (ledger.outstanding_dispatch_id !== expected.outstanding) throw new Error('outstanding dispatch mismatch')
}

const acquireAndDispatch = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.dispatchId, 'dispatchId')
  const stopAtMs = Date.parse(config.stopAt)
  if (!Number.isFinite(stopAtMs) || stopAtMs <= Date.now()) throw new Error('stopAt must be in the future')
  const workCycles = config.workCycles ?? 2
  const minutes = config.minutes ?? 30
  const fullSuiteRuns = config.fullSuiteRuns ?? 1
  if (!Number.isSafeInteger(workCycles) || workCycles < 1
    || !Number.isSafeInteger(minutes) || minutes < 1
    || !Number.isSafeInteger(fullSuiteRuns) || fullSuiteRuns < 0)
    throw new TypeError('attempt limits must be non-negative safe integers with positive cycles/minutes')
  const ledger = await loadLedger(config.runId)
  assertLedgerCas(ledger, { revision: 0, status: 'ready', outstanding: null })
  const lockPath = join(stateDir, `${config.runId}.lock`)
  await access(join(stateDir, `${config.runId}.tombstone`)).then(
    () => { throw new Error('tombstone exists') },
    error => { if (error.code !== 'ENOENT') throw error },
  )
  await mkdir(lockPath, { mode: 0o700 })
  const holderId = randomUUID()
  try {
    const holder = {
      acquired_at: new Date().toISOString(),
      acquired_at_revision: 0,
      coordinator_task_id: config.coordinatorTaskId,
      holder_id: holderId,
    }
    await writeNewFile(join(lockPath, 'holder.json'), canonicalBytes(holder), 0o600)
    await fsyncDir(lockPath)
    await fsyncDir(stateDir)
    await verifyHolder(config.runId, holderId, 0)
    const fresh = await loadLedger(config.runId)
    assertLedgerCas(fresh, { revision: 0, status: 'ready', outstanding: null })

    const inputBaseline = fresh.authorized_wip_input?.snapshot ?? fresh.accepted_baseline
    await verifyPublishedBaselineAgainstLive({
      baseline: inputBaseline,
      worktree: fresh.worktree,
    })

    fresh.attempt = {
      dispatch_id: config.dispatchId,
      input_baseline: inputBaseline,
      kind: fresh.authorized_wip_input === undefined ? 'task' : 'repair',
      receiver_receipt_path: join(stateDir, `${config.runId}.${config.dispatchId}.receiver`),
    }
    fresh.attempt_limits = {
      full_suite_runs: fullSuiteRuns,
      minutes,
      stop_at: config.stopAt,
      work_cycles: workCycles,
    }
    fresh.dispatches.used = 1
    fresh.dispatching_at = new Date().toISOString()
    fresh.outstanding_dispatch_id = config.dispatchId
    fresh.revision = 1
    fresh.status = 'dispatching'
    await atomicReplace(join(stateDir, `${config.runId}.json`), canonicalBytes(fresh), 0o600)
    process.stdout.write(`${JSON.stringify({ holderId, revision: 1, status: 'dispatching' })}\n`)
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true })
    await fsyncDir(stateDir)
    throw error
  }
}

const transition = async (from, to, timestampField) => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.dispatchId, 'dispatchId')
  await verifyHolder(config.runId, config.holderId, config.expectedRevision)
  const ledger = await loadLedger(config.runId)
  assertLedgerCas(ledger, {
    revision: config.expectedRevision,
    status: from,
    outstanding: config.dispatchId,
  })
  await verifyPublishedBaselineAgainstLive({
    baseline: ledger.attempt?.input_baseline ?? ledger.accepted_baseline,
    worktree: ledger.worktree,
  })
  ledger.revision += 1
  ledger.status = to
  ledger[timestampField] = new Date().toISOString()
  await atomicReplace(join(stateDir, `${config.runId}.json`), canonicalBytes(ledger), 0o600)
  process.stdout.write(`${JSON.stringify({ revision: ledger.revision, status: ledger.status })}\n`)
}

const reschedule = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.dispatchId, 'dispatchId')
  const stopAtMs = Date.parse(config.stopAt)
  if (!Number.isFinite(stopAtMs) || stopAtMs <= Date.now()) throw new Error('stopAt must be in the future')
  await verifyHolder(config.runId, config.holderId, config.expectedRevision)
  const ledger = await loadLedger(config.runId)
  assertLedgerCas(ledger, {
    revision: config.expectedRevision,
    status: 'dispatching',
    outstanding: config.dispatchId,
  })
  if (ledger.external_send_confirmed_at) throw new Error('cannot reschedule after send confirmation')
  const receiverPath = ledger.attempt?.receiver_receipt_path
  if (typeof receiverPath !== 'string') throw new Error('receiver path missing')
  await access(receiverPath).then(
    () => { throw new Error('cannot reschedule after receiver claim') },
    error => { if (error.code !== 'ENOENT') throw error },
  )
  await verifyPublishedBaselineAgainstLive({
    baseline: ledger.attempt?.input_baseline ?? ledger.accepted_baseline,
    worktree: ledger.worktree,
  })
  ledger.attempt_limits.stop_at = config.stopAt
  ledger.rescheduled_at = new Date().toISOString()
  ledger.revision += 1
  await atomicReplace(join(stateDir, `${config.runId}.json`), canonicalBytes(ledger), 0o600)
  process.stdout.write(`${JSON.stringify({ revision: ledger.revision, status: ledger.status, stopAt: config.stopAt })}\n`)
}

const confirmSend = async () => {
  await verifyHolder(config.runId, config.holderId, config.expectedRevision)
  const ledger = await loadLedger(config.runId)
  assertLedgerCas(ledger, {
    revision: config.expectedRevision,
    status: 'dispatched',
    outstanding: config.dispatchId,
  })
  ledger.external_send_confirmed_at = new Date().toISOString()
  ledger.revision += 1
  await atomicReplace(join(stateDir, `${config.runId}.json`), canonicalBytes(ledger), 0o600)
  process.stdout.write(`${JSON.stringify({ revision: ledger.revision, status: ledger.status })}\n`)
}

const loadReleasedReceipt = async (ledger, expectedDispatchId = ledger.outstanding_dispatch_id) => {
  const receiptRoot = ledger.attempt?.receiver_receipt_path
  if (typeof receiptRoot !== 'string') throw new Error('receiver receipt path missing')
  const transitionLock = join(receiptRoot, '.transition.lock')
  const assertTransitionIdle = async () => {
    await access(transitionLock).then(
      () => { throw new Error('receiver receipt transition is in progress') },
      error => { if (error.code !== 'ENOENT') throw error },
    )
  }
  await assertTransitionIdle()
  const receipt = JSON.parse(await readFile(join(receiptRoot, 'receipt.json'), 'utf8'))
  await assertTransitionIdle()
  if (receipt.protocol !== 'zcode-callback-receipt/v1'
    || receipt.run_id !== ledger.run_id
    || receipt.dispatch_id !== expectedDispatchId
    || receipt.coordinator_task_id !== ledger.coordinator.task_id
    || receipt.stop_at !== ledger.attempt_limits?.stop_at
    || receipt.status !== 'released') {
    throw new Error('released receipt does not match ledger')
  }
  assertUuid(receipt.receiver_id, 'receiver_id')
  return receipt
}

const assertMatchingSuccessorFence = (fenceBytes, expected) => {
  const existing = JSON.parse(fenceBytes.toString('utf8'))
  const expectedFields = {
    coordinator_task_id: expected.coordinator_task_id,
    protocol: expected.protocol,
    source_revision: expected.source_revision,
    source_run_id: expected.source_run_id,
    successor_run_id: expected.successor_run_id,
  }
  const actualFields = {
    coordinator_task_id: existing.coordinator_task_id,
    protocol: existing.protocol,
    source_revision: existing.source_revision,
    source_run_id: existing.source_run_id,
    successor_run_id: existing.successor_run_id,
  }
  const createdAt = typeof existing.created_at === 'string' ? Date.parse(existing.created_at) : NaN
  if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields)
    || !Number.isFinite(createdAt)
    || Object.keys(existing).length !== 6
    || canonicalBytes(existing).compare(fenceBytes) !== 0) {
    throw new Error('successor fence does not match requested child')
  }
  return existing
}

const fenceExistingSuccessor = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.sourceRunId, 'sourceRunId')
  const child = await loadLedger(config.runId)
  if (child.run_id !== config.runId
    || child.revision !== 0
    || child.status !== 'ready'
    || child.outstanding_dispatch_id !== null
    || child.attempt !== null
    || child.coordinator.task_id !== config.coordinatorTaskId
    || child.authorized_wip_input?.source_run_id !== config.sourceRunId
    || child.authorized_wip_input?.source_revision !== config.sourceRevision) {
    throw new Error('existing successor ledger is not the expected ready child')
  }

  const sourceLockPath = join(stateDir, `${config.sourceRunId}.lock`)
  await access(join(stateDir, `${config.sourceRunId}.tombstone`)).then(
    () => { throw new Error('source tombstone exists') },
    error => { if (error.code !== 'ENOENT') throw error },
  )
  await mkdir(sourceLockPath, { mode: 0o700 })
  const holderId = randomUUID()
  try {
    const holder = {
      acquired_at: new Date().toISOString(),
      acquired_at_revision: config.sourceRevision,
      coordinator_task_id: config.coordinatorTaskId,
      holder_id: holderId,
    }
    await writeNewFile(join(sourceLockPath, 'holder.json'), canonicalBytes(holder), 0o600)
    await fsyncDir(sourceLockPath)
    await fsyncDir(stateDir)
    await verifyHolder(config.sourceRunId, holderId, config.sourceRevision)

    const source = await loadLedger(config.sourceRunId)
    if (source.status !== 'stopped'
      || source.revision !== config.sourceRevision
      || source.outstanding_dispatch_id !== null
      || source.coordinator.task_id !== config.coordinatorTaskId)
      throw new Error('source run is not the expected stopped checkpoint')
    assertUuid(source.attempt?.dispatch_id, 'source attempt dispatch_id')
    const receipt = await loadReleasedReceipt(source, source.attempt.dispatch_id)
    const isRejectedCompletion = receipt.outcome === 'completed'
      && source.last_verdict?.decision === 'rejected'
    const isHandledCheckpoint = ['blocked', 'needs_decision'].includes(receipt.outcome)
      && source.message_type === receipt.outcome
      && source.handled_dispatch_ids.includes(source.attempt.dispatch_id)
    if (!isRejectedCompletion && !isHandledCheckpoint)
      throw new Error('source run is not a consumable stopped checkpoint')

    const freshChild = await loadLedger(config.runId)
    if (canonicalBytes(freshChild).compare(canonicalBytes(child)) !== 0)
      throw new Error('successor ledger changed during source fencing')
    if (canonicalBytes(freshChild.accepted_baseline).compare(canonicalBytes(source.accepted_baseline)) !== 0)
      throw new Error('successor accepted baseline differs from source accepted baseline')
    await verifyPublishedBaselineAgainstLive({
      baseline: freshChild.authorized_wip_input.snapshot,
      worktree: freshChild.worktree,
    })

    const successorFence = {
      coordinator_task_id: config.coordinatorTaskId,
      created_at: new Date().toISOString(),
      protocol: 'zcode-successor-fence/v1',
      source_revision: source.revision,
      source_run_id: source.run_id,
      successor_run_id: freshChild.run_id,
    }
    const fencePath = join(stateDir, `${config.sourceRunId}.successor`)
    await atomicCreate(fencePath, canonicalBytes(successorFence), 0o600)
    await verifyHolder(config.sourceRunId, holderId, config.sourceRevision)
    process.stdout.write(`${JSON.stringify({ fencePath, sourceRunId: source.run_id, successorRunId: freshChild.run_id })}\n`)
  } finally {
    await rm(sourceLockPath, { recursive: true, force: true })
    await fsyncDir(stateDir)
  }
}

const checkpointStoppedReport = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.dispatchId, 'dispatchId')
  if (!['blocked', 'needs_decision'].includes(config.messageType))
    throw new Error('checkpoint-stop only accepts blocked or needs_decision')

  const ledger = await loadLedger(config.runId)
  assertLedgerCas(ledger, {
    revision: config.expectedRevision,
    status: 'dispatched',
    outstanding: config.dispatchId,
  })
  if (ledger.handled_dispatch_ids.includes(config.dispatchId))
    throw new Error('dispatch already handled')

  await access(join(stateDir, `${config.runId}.tombstone`)).then(
    () => { throw new Error('tombstone exists') },
    error => { if (error.code !== 'ENOENT') throw error },
  )
  const lockPath = join(stateDir, `${config.runId}.lock`)
  await mkdir(lockPath, { mode: 0o700 })
  const holderId = randomUUID()
  try {
    const holder = {
      acquired_at: new Date().toISOString(),
      acquired_at_revision: config.expectedRevision,
      coordinator_task_id: config.coordinatorTaskId,
      holder_id: holderId,
    }
    await writeNewFile(join(lockPath, 'holder.json'), canonicalBytes(holder), 0o600)
    await fsyncDir(lockPath)
    await fsyncDir(stateDir)
    await verifyHolder(config.runId, holderId, config.expectedRevision)

    const fresh = await loadLedger(config.runId)
    assertLedgerCas(fresh, {
      revision: config.expectedRevision,
      status: 'dispatched',
      outstanding: config.dispatchId,
    })
    if (fresh.handled_dispatch_ids.includes(config.dispatchId))
      throw new Error('dispatch already handled')
    const receipt = await loadReleasedReceipt(fresh)
    if (receipt.outcome !== config.messageType)
      throw new Error('receipt outcome does not match message type')

    const stoppedAt = new Date().toISOString()
    fresh.handled_dispatch_ids.push(config.dispatchId)
    fresh.message_type = config.messageType
    fresh.callback_delivery_status = config.callbackDeliveryStatus ?? null
    fresh.outstanding_dispatch_id = null
    fresh.revision += 1
    fresh.status = 'stopped'
    fresh.stop_reason = config.stopReason ?? receipt.reason ?? `${config.messageType} callback received`
    fresh.stopped_at = stoppedAt
    await verifyHolder(config.runId, holderId, config.expectedRevision)
    await atomicReplace(join(stateDir, `${config.runId}.json`), canonicalBytes(fresh), 0o600)
    process.stdout.write(`${JSON.stringify({ revision: fresh.revision, status: fresh.status, stopReason: fresh.stop_reason })}\n`)
  } finally {
    await rm(lockPath, { recursive: true, force: true })
    await fsyncDir(stateDir)
  }
}

const acquireCompletedReview = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.dispatchId, 'dispatchId')
  if (config.messageType !== 'completed') throw new Error('only completed may enter review')
  const ledger = await loadLedger(config.runId)
  assertLedgerCas(ledger, {
    revision: config.expectedRevision,
    status: 'dispatched',
    outstanding: config.dispatchId,
  })
  if (ledger.handled_dispatch_ids.includes(config.dispatchId)) throw new Error('dispatch already handled')
  await access(join(stateDir, `${config.runId}.tombstone`)).then(
    () => { throw new Error('tombstone exists') },
    error => { if (error.code !== 'ENOENT') throw error },
  )
  const lockPath = join(stateDir, `${config.runId}.lock`)
  await mkdir(lockPath, { mode: 0o700 })
  const holderId = randomUUID()
  try {
    const holder = {
      acquired_at: new Date().toISOString(),
      acquired_at_revision: config.expectedRevision,
      coordinator_task_id: config.coordinatorTaskId,
      holder_id: holderId,
    }
    await writeNewFile(join(lockPath, 'holder.json'), canonicalBytes(holder), 0o600)
    await fsyncDir(lockPath)
    await fsyncDir(stateDir)
    await verifyHolder(config.runId, holderId, config.expectedRevision)

    const fresh = await loadLedger(config.runId)
    assertLedgerCas(fresh, {
      revision: config.expectedRevision,
      status: 'dispatched',
      outstanding: config.dispatchId,
    })
    if (fresh.handled_dispatch_ids.includes(config.dispatchId)) throw new Error('dispatch already handled')
    const receipt = await loadReleasedReceipt(fresh)
    if (receipt.outcome !== config.messageType) throw new Error('receipt outcome does not match message type')

    fresh.handled_dispatch_ids.push(config.dispatchId)
    fresh.message_type = config.messageType
    fresh.callback_delivery_status = config.callbackDeliveryStatus
    fresh.reviewing_at = new Date().toISOString()
    fresh.revision += 1
    fresh.status = 'reviewing'
    await verifyHolder(config.runId, holderId, config.expectedRevision)
    await atomicReplace(join(stateDir, `${config.runId}.json`), canonicalBytes(fresh), 0o600)
    process.stdout.write(`${JSON.stringify({ holderId, revision: fresh.revision, status: fresh.status })}\n`)
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true })
    await fsyncDir(stateDir)
    throw error
  }
}

const acceptCompletedReview = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.dispatchId, 'dispatchId')
  await verifyHolder(config.runId, config.holderId, config.expectedRevision)
  const ledger = await loadLedger(config.runId)
  assertLedgerCas(ledger, {
    revision: config.expectedRevision,
    status: 'reviewing',
    outstanding: config.dispatchId,
  })
  if (ledger.message_type !== 'completed' || !ledger.handled_dispatch_ids.includes(config.dispatchId))
    throw new Error('completed dispatch is not recorded as handled')
  const receipt = await loadReleasedReceipt(ledger)
  if (receipt.outcome !== 'completed') throw new Error('receipt outcome is not completed')

  const state = liveState(ledger.worktree)
  if (state.head !== ledger.accepted_baseline.head || state.branch !== ledger.branch)
    throw new Error('live HEAD or branch changed during review')
  if (state.staged.length !== 0) throw new Error('acceptance requires an empty staged patch')
  if (state.status !== config.expectedStatus || sha256(state.unstaged) !== config.expectedUnstagedSha256)
    throw new Error('reviewed status or unstaged patch changed before acceptance')
  const tracked = git(ledger.worktree, ['diff', '--name-only', '-z', '--no-renames'])
    .toString('utf8').split('\0').filter(Boolean).sort()
  const expectedTracked = [...config.allowedTracked].sort()
  if (JSON.stringify(tracked) !== JSON.stringify(expectedTracked))
    throw new Error(`tracked write set mismatch: ${JSON.stringify(tracked)}`)
  const expectedUntracked = [...config.allowedUntracked].sort()
  if (JSON.stringify(state.untracked) !== JSON.stringify(expectedUntracked))
    throw new Error(`untracked write set mismatch: ${JSON.stringify(state.untracked)}`)
  const expectedUntrackedDigestPaths = Object.keys(config.expectedUntrackedSha256).sort()
  if (JSON.stringify(expectedUntrackedDigestPaths) !== JSON.stringify(expectedUntracked))
    throw new Error('untracked digest paths do not exactly match the accepted write set')
  for (const [relativePath, expectedSha] of Object.entries(config.expectedUntrackedSha256)) {
    if (!state.untracked.includes(relativePath)) throw new Error(`expected untracked file is missing: ${relativePath}`)
    const bytes = await readFile(join(ledger.worktree, ...relativePath.split('/')))
    if (sha256(bytes) !== expectedSha) throw new Error(`untracked digest mismatch: ${relativePath}`)
  }

  const snapshotLabel = `accepted-r${config.expectedRevision + 1}`
  const { baseline, manifest } = await capturePublishedSnapshot({
    runId: config.runId,
    label: snapshotLabel,
    worktree: ledger.worktree,
    state,
    expectedUnstagedSha256: config.expectedUnstagedSha256,
    expectedUntrackedSha256: config.expectedUntrackedSha256,
  })
  assertManifestMatchesReviewedState({
    manifest,
    state,
    worktree: ledger.worktree,
    expectedUnstagedSha256: config.expectedUnstagedSha256,
    expectedUntrackedSha256: config.expectedUntrackedSha256,
  })
  await assertLiveStateMatchesManifest(ledger.worktree, manifest)
  const fresh = await loadLedger(config.runId)
  assertLedgerCas(fresh, {
    revision: config.expectedRevision,
    status: 'reviewing',
    outstanding: config.dispatchId,
  })
  if (fresh.message_type !== 'completed' || !fresh.handled_dispatch_ids.includes(config.dispatchId))
    throw new Error('review state changed before acceptance CAS')

  const acceptedAt = new Date().toISOString()
  fresh.accepted_baseline = baseline
  fresh.last_verdict = {
    accepted_at: acceptedAt,
    callback_delivery_status: fresh.callback_delivery_status,
    decision: 'accepted',
    evidence: config.evidence,
    task: fresh.current_task,
  }
  fresh.outstanding_dispatch_id = null
  fresh.revision += 1
  fresh.status = 'complete'
  fresh.completed_at = acceptedAt
  fresh.stop_reason = null
  await verifyHolder(config.runId, config.holderId, config.expectedRevision)
  await atomicReplace(join(stateDir, `${config.runId}.json`), canonicalBytes(fresh), 0o600)
  process.stdout.write(`${JSON.stringify({ baseline, revision: fresh.revision, status: fresh.status })}\n`)
}

const rejectCompletedReview = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.dispatchId, 'dispatchId')
  await verifyHolder(config.runId, config.holderId, config.expectedRevision)
  const ledger = await loadLedger(config.runId)
  assertLedgerCas(ledger, {
    revision: config.expectedRevision,
    status: 'reviewing',
    outstanding: config.dispatchId,
  })
  if (ledger.message_type !== 'completed' || !ledger.handled_dispatch_ids.includes(config.dispatchId))
    throw new Error('completed dispatch is not recorded as handled')
  const receipt = await loadReleasedReceipt(ledger)
  if (receipt.outcome !== 'completed') throw new Error('receipt outcome is not completed')

  const state = liveState(ledger.worktree)
  if (state.head !== ledger.accepted_baseline.head || state.branch !== ledger.branch)
    throw new Error('live HEAD or branch changed during review')
  if (state.staged.length !== 0) throw new Error('review rejection requires an empty staged patch')
  if (state.status !== config.expectedStatus || sha256(state.unstaged) !== config.expectedUnstagedSha256)
    throw new Error('reviewed status or unstaged patch changed before rejection')
  const tracked = git(ledger.worktree, ['diff', '--name-only', '-z', '--no-renames'])
    .toString('utf8').split('\0').filter(Boolean).sort()
  const expectedTracked = [...config.allowedTracked].sort()
  if (JSON.stringify(tracked) !== JSON.stringify(expectedTracked))
    throw new Error(`tracked write set mismatch: ${JSON.stringify(tracked)}`)
  const expectedUntracked = [...config.allowedUntracked].sort()
  if (JSON.stringify(state.untracked) !== JSON.stringify(expectedUntracked))
    throw new Error(`untracked write set mismatch: ${JSON.stringify(state.untracked)}`)
  const expectedUntrackedDigestPaths = Object.keys(config.expectedUntrackedSha256).sort()
  if (JSON.stringify(expectedUntrackedDigestPaths) !== JSON.stringify(expectedUntracked))
    throw new Error('untracked digest paths do not exactly match the reviewed write set')
  for (const [relativePath, expectedSha] of Object.entries(config.expectedUntrackedSha256)) {
    const bytes = await readFile(join(ledger.worktree, ...relativePath.split('/')))
    if (sha256(bytes) !== expectedSha) throw new Error(`untracked digest mismatch: ${relativePath}`)
  }

  if (!Array.isArray(config.findings) || config.findings.length === 0)
    throw new TypeError('findings must be a non-empty array')
  const fingerprints = config.findings.map(finding => sha256(canonicalBytes(finding)))
  if (new Set(fingerprints).size !== fingerprints.length)
    throw new Error('duplicate finding fingerprints in review verdict')
  if (fingerprints.some(fingerprint => ledger.finding_fingerprints.includes(fingerprint)))
    throw new Error('review finding fingerprint already exists')

  const fresh = await loadLedger(config.runId)
  assertLedgerCas(fresh, {
    revision: config.expectedRevision,
    status: 'reviewing',
    outstanding: config.dispatchId,
  })
  const reviewedAt = new Date().toISOString()
  fresh.finding_fingerprints.push(...fingerprints)
  fresh.last_verdict = {
    decision: 'rejected',
    evidence: config.evidence,
    finding_fingerprints: fingerprints,
    reviewed_at: reviewedAt,
    task: fresh.current_task,
  }
  fresh.outstanding_dispatch_id = null
  fresh.revision += 1
  fresh.status = 'stopped'
  fresh.stop_reason = config.stopReason
  fresh.stopped_at = reviewedAt
  await verifyHolder(config.runId, config.holderId, config.expectedRevision)
  await atomicReplace(join(stateDir, `${config.runId}.json`), canonicalBytes(fresh), 0o600)
  process.stdout.write(`${JSON.stringify({ fingerprints, revision: fresh.revision, status: fresh.status })}\n`)
}

const releaseLock = async () => {
  const { lockPath } = await verifyHolder(config.runId, config.holderId, config.expectedRevision)
  const ledger = await loadLedger(config.runId)
  assertLedgerCas(ledger, {
    revision: config.expectedRevision,
    status: config.expectedStatus,
    outstanding: Object.hasOwn(config, 'expectedOutstanding') ? config.expectedOutstanding : config.dispatchId,
  })
  await rm(lockPath, { recursive: true })
  await fsyncDir(stateDir)
  process.stdout.write(`${JSON.stringify({ released: true, revision: ledger.revision, status: ledger.status })}\n`)
}

const runBridgeReconcile = async args => {
  const script = process.env.ZCODE_CALLBACK_BRIDGE_RECONCILE
  if (typeof script !== 'string' || script.length === 0)
    throw new Error('ZCODE_CALLBACK_BRIDGE_RECONCILE must locate the authorized bridge reconcile entry')
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.status !== 0)
    throw new Error('bridge reconcile entry failed (' + result.status + '): ' + (result.stderr?.trim() ?? ''))
  return JSON.parse(result.stdout)
}

const requireLedgerPath = () => {
  const ledgerPath = config.ledgerPath
  if (typeof ledgerPath !== 'string' || ledgerPath.length === 0)
    throw new TypeError('ledgerPath must name the dispatched ledger for reconciliation')
  return ledgerPath
}

const reconcileReceipt = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.dispatchId, 'dispatchId')
  if (!Number.isSafeInteger(config.expectedRevision))
    throw new TypeError('expectedRevision must be a safe integer')
  const payload = await runBridgeReconcile(['reconcile', '--ledger', requireLedgerPath(), '--run-id', config.runId,
    '--dispatch-id', config.dispatchId, '--coordinator-task-id', config.coordinatorTaskId,
    '--expected-revision', String(config.expectedRevision)])
  process.stdout.write(`${JSON.stringify(payload)}
`)
}

const reviewHolder = async () => {
  assertUuid(config.runId, 'runId')
  assertUuid(config.dispatchId, 'dispatchId')
  const payload = await runBridgeReconcile(['holder', '--ledger', requireLedgerPath(), '--run-id', config.runId,
    '--dispatch-id', config.dispatchId, '--coordinator-task-id', config.coordinatorTaskId,
    '--expected-revision', String(config.expectedRevision)])
  process.stdout.write(`${JSON.stringify(payload)}
`)
}

if (command === 'create') await createSnapshotAndLedger()
else if (command === 'create-from-wip') await createFromAuthorizedWip()
else if (command === 'dispatching') await acquireAndDispatch()
else if (command === 'reschedule') await reschedule()
else if (command === 'dispatched') await transition('dispatching', 'dispatched', 'dispatched_at')
else if (command === 'confirm-send') await confirmSend()
else if (command === 'fence-existing-successor') await fenceExistingSuccessor()
else if (command === 'checkpoint-stop') await checkpointStoppedReport()
else if (command === 'review-completed') await acquireCompletedReview()
else if (command === 'accept-complete') await acceptCompletedReview()
else if (command === 'reject-stop') await rejectCompletedReview()
else if (command === 'release-lock') await releaseLock()
else if (command === 'reconcile-receipt') await reconcileReceipt()
else if (command === 'review-holder') await reviewHolder()
else throw new TypeError(`unknown command: ${command}`)
