// 中文安装引导（scripts/setup.mjs）的行为测试 —— 返修版。
// 全部使用 mkdtemp 隔离的临时 HOME / CODEX_HOME / 状态 / 配置，绝不触碰真实路径。
// 相对上一轮的语义变化（均有依据）：
// 1) Hook 配置默认位于 $CODEX_HOME/hooks.json（用户级，与 config.toml 并列），不再是 hooks/hooks.json；
// 2) 安装命令收敛为一条：node scripts/setup.mjs（非交互显式授权用 --yes），--preview 只读；
// 3) 新增：确认后重新核验、回滚并发保护与 mode 保持、清单/备份路径边界、Hook 命令真实执行、
//    doctor 退出码判定、CODEX_HOME 隔离。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat, rm } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SETUP = join(repoRoot, 'scripts', 'setup.mjs')

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd']

const pathsIn = home => {
  const codexHome = join(home, '.codex')
  return {
    codexHome,
    bridgeSkill: join(home, '.zcode/skills/codex-callback-bridge'),
    orchestratorSkill: join(home, '.agents/skills/orchestrating-coding-workers'),
    coordinator: join(codexHome, 'tools/coordinator-run-v1.mjs'),
    guard: join(codexHome, 'hooks/zcode_ui_guard.py'),
    hooksConfig: join(codexHome, 'hooks.json'),
    manifest: join(codexHome, 'state/zcode-bridge-install.json'),
    reconcileEntry: join(home, '.zcode/skills/codex-callback-bridge/scripts/reconcile.mjs'),
  }
}

const runSetup = (args, home, options = {}) =>
  spawnSync(process.execPath, [SETUP, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), ...options.env },
    ...options.spawn,
  })

const sha256 = value => createHash('sha256').update(value).digest('hex')
const treeDigest = root => {
  const digest = createHash('sha256')
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else digest.update(`${full}\0${sha256(readFileSync(full))}\n`)
    }
  }
  walk(root)
  return digest.digest('hex')
}
const readSync = path => readFileSync(path, 'utf8')

async function makeHome(specialName) {
  const base = await mkdtemp(join(tmpdir(), 'zcode-bridge-repair-test-'))
  const home = specialName ? join(base, specialName) : base
  await mkdir(home, { recursive: true })
  return home
}

const hookCommandOf = home => `python3 '${pathsIn(home).guard}'`
const canonicalEntry = (home, event) => {
  const hook = { type: 'command', command: hookCommandOf(home), timeout: event === 'PreToolUse' ? 5 : 3 }
  return event === 'PreToolUse' || event === 'PostToolUse' ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }
}
const hookEntriesOf = (config, event) => config.hooks?.[event] ?? []

async function seedUserHooks(home, mode = 0o644) {
  const hooksConfig = pathsIn(home).hooksConfig
  await mkdir(dirname(hooksConfig), { recursive: true })
  const userConfig = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-first', timeout: 1 }] },
      ],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'echo user-cleanup' }] }],
    },
  }
  await writeFile(hooksConfig, JSON.stringify(userConfig, null, 2) + '\n', { mode })
  return userConfig
}

test('只读预览不写入任何路径，并列出精确目标', async () => {
  const home = await makeHome()
  const result = runSetup(['--preview'], home)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /预览/)
  assert.match(result.stdout, new RegExp(pathsIn(home).hooksConfig))
  for (const target of [pathsIn(home).bridgeSkill, pathsIn(home).orchestratorSkill, pathsIn(home).manifest]) {
    assert.equal(existsSync(target), false, `不应存在 ${target}`)
  }
  assert.equal(existsSync(pathsIn(home).hooksConfig), false)
})

test('首次安装：Hook 配置写在 $CODEX_HOME/hooks.json 用户级路径，且尊重 CODEX_HOME', async () => {
  const base = await mkdtemp(join(tmpdir(), 'zcode-bridge-codexhome-'))
  const home = join(base, 'home')
  const codexHome = join(base, 'custom-codex-home')
  await mkdir(home, { recursive: true })
  const before = treeDigest(repoRoot)
  const result = runSetup(['--yes'], home, { env: { CODEX_HOME: codexHome } })
  assert.equal(result.status, 0, result.stderr)
  // 用户级 Hook 配置与 config.toml 并列，而不是插件内部 hooks/hooks.json
  assert.equal(existsSync(join(codexHome, 'hooks.json')), true)
  assert.equal(existsSync(join(codexHome, 'hooks/hooks.json')), false, '不得写进插件内部默认路径')
  assert.equal(existsSync(join(codexHome, 'hooks/zcode_ui_guard.py')), true)
  assert.equal(existsSync(join(codexHome, 'tools/coordinator-run-v1.mjs')), true)
  assert.equal(existsSync(join(home, '.zcode/skills/codex-callback-bridge/SKILL.md')), true)
  assert.equal(existsSync(join(home, '.agents/skills/orchestrating-coding-workers/SKILL.md')), true)
  const config = JSON.parse(readSync(join(codexHome, 'hooks.json')))
  for (const event of HOOK_EVENTS) {
    const entries = hookEntriesOf(config, event).filter(entry => JSON.stringify(entry).includes('zcode_ui_guard.py'))
    const hook = { type: 'command', command: `python3 '${join(codexHome, 'hooks/zcode_ui_guard.py')}'`, timeout: event === 'PreToolUse' ? 5 : 3 }
    const canonical = event === 'PreToolUse' || event === 'PostToolUse' ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }
    assert.equal(entries.length, 1, `${event} 应恰好有一条本包 guard 条目`)
    assert.deepEqual(entries[0], canonical)
  }
  assert.equal(treeDigest(repoRoot), before, '安装过程不得修改仓库源')
  assert.match(result.stdout, /ZCODE_CALLBACK_BRIDGE_RECONCILE/)
  assert.match(result.stdout, /zcodeModel/)
})

test('重复安装幂等：不重复 Hook 条目、不产生新的写入', async () => {
  const home = await makeHome()
  assert.equal(runSetup(['--yes'], home).status, 0)
  const p = pathsIn(home)
  const hooksBefore = readSync(p.hooksConfig)
  const guardBefore = readSync(p.guard)
  const manifestBefore = readSync(p.manifest)
  const result = runSetup(['--yes'], home)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readSync(p.hooksConfig), hooksBefore)
  assert.equal(readSync(p.guard), guardBefore)
  const config = JSON.parse(readSync(p.hooksConfig))
  for (const event of HOOK_EVENTS) {
    assert.equal(hookEntriesOf(config, event).filter(e => JSON.stringify(e).includes('zcode_ui_guard.py')).length, 1)
  }
  assert.equal(readSync(p.manifest), manifestBefore)
})

test('非交互环境未给显式授权时不写入', async () => {
  const home = await makeHome()
  const result = runSetup([], home)
  assert.notEqual(result.status, 0)
  const p = pathsIn(home)
  for (const target of [p.bridgeSkill, p.orchestratorSkill, p.coordinator, p.manifest]) {
    assert.equal(existsSync(target), false)
  }
  const declined = runSetup([], home, { spawn: { input: 'no\n' } })
  assert.notEqual(declined.status, 0)
  assert.equal(existsSync(p.manifest), false)
})

test('安装保留用户已有 Hook 条目及其顺序', async () => {
  const home = await makeHome()
  const userConfig = await seedUserHooks(home)
  const result = runSetup(['--yes'], home)
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(readSync(pathsIn(home).hooksConfig))
  assert.deepEqual(hookEntriesOf(config, 'PreToolUse')[0], userConfig.hooks.PreToolUse[0])
  assert.deepEqual(hookEntriesOf(config, 'SessionEnd')[0], userConfig.hooks.SessionEnd[0])
  assert.equal(hookEntriesOf(config, 'PreToolUse').length, 2)
})

test('损坏或未知结构的 Hook 配置拒绝写入', async () => {
  for (const bad of ['{"hooks": {', '{"hooks": []}', '{"hooks": {"PreToolUse": "oops"}}', '[]']) {
    const home = await makeHome()
    const hooksConfig = pathsIn(home).hooksConfig
    await mkdir(dirname(hooksConfig), { recursive: true })
    await writeFile(hooksConfig, bad)
    const before = readSync(hooksConfig)
    const result = runSetup(['--yes'], home)
    assert.notEqual(result.status, 0, `应拒绝非法配置：${bad}`)
    assert.match(result.stdout + result.stderr, /拒绝|无法/)
    assert.equal(readSync(hooksConfig), before)
    assert.equal(existsSync(pathsIn(home).manifest), false)
  }
})

test('未归属的既有目标拒绝覆盖', async () => {
  const home = await makeHome()
  const p = pathsIn(home)
  await mkdir(dirname(p.guard), { recursive: true })
  await writeFile(p.guard, '# 不是本包写入的 guard\n')
  const result = runSetup(['--yes'], home)
  assert.notEqual(result.status, 0)
  assert.equal(readSync(p.guard), '# 不是本包写入的 guard\n')
  assert.equal(existsSync(p.manifest), false)
  assert.equal(existsSync(p.bridgeSkill), false)
})

test('用户修改过本包已安装文件后拒绝静默覆盖', async () => {
  const home = await makeHome()
  assert.equal(runSetup(['--yes'], home).status, 0)
  const p = pathsIn(home)
  const modified = '#!/usr/bin/env python3\n# 用户自己的改动\n'
  await writeFile(p.guard, modified)
  const result = runSetup(['--yes'], home)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /修改|拒绝/)
  assert.equal(readSync(p.guard), modified, '用户的修改必须原样保留')
})

test('符号链接目标拒绝写入', async () => {
  const home = await makeHome()
  const elsewhere = join(home, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })
  const hooksDir = join(home, '.codex/hooks')
  await mkdir(dirname(hooksDir), { recursive: true })
  await symlink(elsewhere, hooksDir, 'dir')
  const result = runSetup(['--yes'], home)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /符号链接/)
  assert.equal(existsSync(pathsIn(home).manifest), false)
})

test('状态目录是 HOME 外符号链接时，清单不得沿链接写出', async () => {
  const home = await makeHome()
  const outside = await mkdtemp(join(tmpdir(), 'zcode-bridge-outside-'))
  const stateDir = join(home, '.codex/state')
  await mkdir(dirname(stateDir), { recursive: true })
  await symlink(outside, stateDir, 'dir')
  const result = runSetup(['--yes'], home)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /符号链接/)
  assert.equal(existsSync(join(outside, 'zcode-bridge-install.json')), false, '不得沿符号链接写安装清单')
  assert.equal(readdirSync(outside).length, 0, '符号链接目标目录不得有任何写入')
})

test('中途失败回滚本次安装拥有的文件，保留用户配置', async () => {
  const home = await makeHome()
  const userConfig = await seedUserHooks(home)
  const p = pathsIn(home)
  const result = runSetup(['--yes'], home, {
    env: { ZCODE_BRIDGE_SETUP_TEST_FAULT: 'before-hooks-merge' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /回滚|恢复/)
  for (const target of [p.bridgeSkill, p.orchestratorSkill, p.coordinator, p.manifest]) {
    assert.equal(existsSync(target), false, `回滚后不应存在 ${target}`)
  }
  assert.deepEqual(JSON.parse(readSync(p.hooksConfig)), userConfig)
})

test('确认后出现并发用户新文件：过期计划不得覆盖，须重新提示', async () => {
  const home = await makeHome()
  const p = pathsIn(home)
  const preview = runSetup(['--preview'], home)
  assert.equal(preview.status, 0)
  // 预览之后、确认之前，用户创建了自己的 guard 文件
  await mkdir(dirname(p.guard), { recursive: true })
  const userBytes = '#!/usr/bin/env python3\n# USER_CREATED_AFTER_PREVIEW\n'
  await writeFile(p.guard, userBytes)
  const result = runSetup(['--yes'], home)
  assert.notEqual(result.status, 0, '不得按过期计划继续写入')
  assert.equal(readSync(p.guard), userBytes, '用户在确认窗口内创建的文件必须原样保留')
  assert.equal(existsSync(p.manifest), false)
})

test('回滚不得丢失并发修改，且不放宽配置 mode', async () => {
  const home = await makeHome()
  await seedUserHooks(home, 0o600)
  const p = pathsIn(home)
  // preload fixture：在本包合并 hooks.json 落盘后，立即模拟用户并发写入一个新字段
  const fixture = join(home, 'concurrent-preload.cjs')
  await writeFile(
    fixture,
    `const fs = require('node:fs')
const renameSync = fs.renameSync
let done = false
fs.renameSync = function (from, to, ...rest) {
  const result = renameSync.call(this, from, to, ...rest)
  if (!done && typeof to === 'string' && to.endsWith('hooks.json')) {
    done = true
    const parsed = JSON.parse(fs.readFileSync(to, 'utf8'))
    parsed.user_concurrent_field = 'keep-me'
    fs.writeFileSync(to, JSON.stringify(parsed, null, 2) + '\\n', { mode: 0o600 })
  }
  return result
}`,
  )
  const result = runSetup(['--yes'], home, {
    env: {
      ZCODE_BRIDGE_SETUP_TEST_FAULT: 'before-manifest',
      NODE_OPTIONS: `--require ${fixture}`,
    },
  })
  assert.notEqual(result.status, 0, '清单发布失败必须以失败收场')
  assert.match(result.stdout + result.stderr, /人工|保留|未恢复/)
  const final = JSON.parse(readSync(p.hooksConfig))
  assert.equal(final.user_concurrent_field, 'keep-me', '回滚不得抹掉用户的并发修改')
  assert.ok(hookEntriesOf(final, 'PreToolUse').some(e => JSON.stringify(e).includes('zcode_ui_guard.py')), '现场保留，不误报已回滚')
  const mode = (await stat(p.hooksConfig)).mode & 0o777
  assert.equal(mode, 0o600, '配置 mode 不得被放宽')
  assert.equal(existsSync(p.manifest), false)
})

test('Hook 命令真实可执行：HOME 含空格、单引号、美元符时 /bin/sh 执行成功', async () => {
  const home = await makeHome(`sp ace$q'uo'te`)
  const result = runSetup(['--yes'], home)
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(readSync(pathsIn(home).hooksConfig))
  const entry = hookEntriesOf(config, 'Stop').find(e => JSON.stringify(e).includes('zcode_ui_guard.py'))
  assert.ok(entry, '应存在 guard 条目')
  const execution = spawnSync('/bin/sh', ['-c', entry.hooks[0].command], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'fixture-session' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), CODEX_ZCODE_UI_STATE_PATH: join(home, '.codex/state/zcode-ui-lock.json') },
  })
  assert.equal(execution.status, 0, `Hook 命令必须真实可执行：${entry.hooks[0].command}\nstderr: ${execution.stderr}`)
  // 打印的 export 行同样必须可直接执行
  const exportLine = result.stdout.split('\n').find(line => /^\s*export ZCODE_CALLBACK_BRIDGE_RECONCILE=/.test(line))
  assert.ok(exportLine, '应打印可复制的 export 行')
  const echo = spawnSync('/bin/sh', ['-c', `${exportLine.trim()}; printenv ZCODE_CALLBACK_BRIDGE_RECONCILE`], { encoding: 'utf8' })
  assert.equal(echo.status, 0, 'export 行必须可在 shell 中执行')
  assert.equal(echo.stdout.trim(), pathsIn(home).reconcileEntry)
})

test('doctor 判定可靠：文件缺失非零、绑定异常非零、内联绑定可复制', async () => {
  const home = await makeHome()
  const fresh = runSetup(['--doctor'], home)
  assert.notEqual(fresh.status, 0, '未安装时 doctor 应报告缺失')
  assert.equal(existsSync(pathsIn(home).manifest), false, 'doctor 不得写入')

  assert.equal(runSetup(['--yes'], home).status, 0)
  const p = pathsIn(home)
  const installed = runSetup(['--doctor'], home)
  assert.equal(installed.status, 0, installed.stdout + installed.stderr)
  const text = installed.stdout + installed.stderr
  assert.match(text, /宿主.*未验证|未验证.*宿主/)
  assert.match(text, /权限.*人工|人工.*权限|待确认/)
  assert.match(text, /端到端.*未验证|未验证.*端到端/)
  assert.doesNotMatch(text, /权限已授予|回传成功|已验证通过/)
  for (const target of [p.bridgeSkill, p.orchestratorSkill, p.coordinator, p.guard, p.manifest, p.hooksConfig]) {
    assert.equal(existsSync(target), true, `doctor 不得删除已安装内容：${target}`)
  }
  // 对账绑定指向不存在的文件 → 必须失败而不是静默通过
  const broken = runSetup(['--doctor'], home, { env: { ZCODE_CALLBACK_BRIDGE_RECONCILE: join(home, 'no', 'such', 'reconcile.mjs') } })
  assert.notEqual(broken.status, 0, 'reconcile 绑定指向缺失文件时 doctor 必须失败')
})

test('README 提供可复制的获取步骤与首个任务示例', async () => {
  const readme = readSync(join(repoRoot, 'README.md'))
  assert.match(readme, /git clone https:\/\/github\.com\/galen-jiang\/zcode-codex-bridge\.git/, '必须包含可复制的真实 clone 命令')
  assert.match(readme, /cd zcode-codex-bridge\b/, 'cd 目录必须与 clone 默认目录一致')
  assert.doesNotMatch(readme, /<仓库发布地址>/, '不得保留待替换远端占位符')
  assert.match(readme, /node scripts\/setup\.mjs/, '安装入口应为单条交互命令')
  assert.match(readme, /首任务|第一个任务/, '必须包含首个任务示例章节')
  assert.match(readme, /只读/, '首任务示例必须是只读小任务')
  assert.match(readme, /zcodeModel|模型.*选择|选择.*模型/, '模型由用户选择')
})

test('安装完成后的提示包含 reconcile 绝对路径绑定与模型自选说明', async () => {
  const home = await makeHome()
  const result = runSetup(['--yes'], home)
  assert.match(result.stdout, new RegExp(pathsIn(home).reconcileEntry.replace(/\./g, '\\.')))
  assert.match(result.stdout, /模型.*安装者|安装者.*模型|zcodeModel/)
})

test('升级复制失败：旧文件与备份可恢复，不得虚报回滚完成', async () => {
  const home = await makeHome()
  assert.equal(runSetup(['--yes'], home).status, 0)
  const p = pathsIn(home)
  // 构造"归属明确但为旧版本"的 guard：内容修改后把清单 digest 同步为该内容
  const oldBytes = '#!/usr/bin/env python3\n# OWNED_OLD_VERSION\n'
  await writeFile(p.guard, oldBytes)
  const manifest = JSON.parse(readSync(p.manifest))
  for (const target of manifest.targets) {
    if (target.path === p.guard) target.digest = sha256(oldBytes)
  }
  await writeFile(p.manifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  // preload：仅对"从仓库源复制 guard 到安装目标"这一次调用注入 EIO（备份复制不受影响）
  const fixture = join(home, 'copy-fail-preload.cjs')
  await writeFile(
    fixture,
    `const fs = require('node:fs')
const copyFileSync = fs.copyFileSync
fs.copyFileSync = function (src, dest, ...rest) {
  if (process.env.COPY_GUARD_FAIL === '1' && String(src).endsWith('scripts/zcode_ui_guard.py') && String(dest) === process.env.GUARD_DEST) {
    const error = new Error('injected EIO during replacement copy')
    error.code = 'EIO'
    throw error
  }
  return copyFileSync.call(this, src, dest, ...rest)
}`,
  )
  const stateBefore = readdirSync(join(home, '.codex/state')).filter(name => name.includes('backup'))
  const result = runSetup(['--yes'], home, {
    env: {
      COPY_GUARD_FAIL: '1',
      GUARD_DEST: p.guard,
      NODE_OPTIONS: `--require ${fixture}`,
    },
  })
  assert.notEqual(result.status, 0, '替换复制失败必须以失败收场')
  assert.equal(readSync(p.guard), oldBytes, '旧版 guard 必须被恢复（或备份可核验保留）')
  const stateAfter = readdirSync(join(home, '.codex/state')).filter(name => name.includes('backup'))
  assert.ok(stateAfter.length >= stateBefore.length && stateAfter.length > 0, '必须保留可核验备份，不得清空备份目录')
  assert.match(result.stdout + result.stderr, /失败|恢复|人工|备份/)
})

test('写入期路径边界：复制完成后出现的 state 符号链接不得沿链接写清单', async () => {
  const home = await makeHome()
  const outside = await mkdtemp(join(tmpdir(), 'zcode-bridge-late-link-'))
  const fixture = join(home, 'late-link-preload.cjs')
  await writeFile(
    fixture,
    `const fs = require('node:fs')
const cpSync = fs.cpSync
let done = false
fs.cpSync = function (src, dest, opts) {
  const result = cpSync.call(this, src, dest, opts)
  if (!done && typeof dest === 'string' && dest.includes('.zcode/skills/codex-callback-bridge')) {
    done = true
    fs.mkdirSync(require('node:path').dirname(process.env.LATE_STATE_LINK), { recursive: true })
    fs.symlinkSync(process.env.LATE_STATE_TARGET, process.env.LATE_STATE_LINK, 'dir')
  }
  return result
}`,
  )
  const result = runSetup(['--yes'], home, {
    env: {
      LATE_STATE_LINK: join(home, '.codex/state'),
      LATE_STATE_TARGET: outside,
      NODE_OPTIONS: `--require ${fixture}`,
    },
  })
  assert.notEqual(result.status, 0, '写入期发现边界变化必须安全停止')
  assert.equal(readdirSync(outside).length, 0, '外部目录不得有任何写入')
  assert.match(result.stdout + result.stderr, /符号链接|拒绝|失败/)
  assert.equal(existsSync(pathsIn(home).manifest), false)
})

test('特殊字符 HOME 下重复安装幂等：不改写清单与 Hook、不产生无谓备份', async () => {
  const home = await makeHome(`idem'$q te st`)
  assert.equal(runSetup(['--yes'], home).status, 0)
  const p = pathsIn(home)
  const stateDir = join(home, '.codex/state')
  const backupsBefore = readdirSync(stateDir).filter(name => name.includes('backup')).length
  const hooksBefore = readSync(p.hooksConfig)
  const manifestBefore = readSync(p.manifest)
  const result = runSetup(['--yes'], home)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readSync(p.hooksConfig), hooksBefore, '重复安装不得改写 Hook 配置')
  assert.equal(readSync(p.manifest), manifestBefore, '重复安装不得改写安装清单')
  const backupsAfter = readdirSync(stateDir).filter(name => name.includes('backup')).length
  assert.equal(backupsAfter, backupsBefore, '重复安装不得产生无谓备份')
  const config = JSON.parse(readSync(p.hooksConfig))
  for (const event of HOOK_EVENTS) {
    assert.equal(hookEntriesOf(config, event).filter(e => JSON.stringify(e).includes('zcode_ui_guard.py')).length, 1)
  }
})

test('备份不得沿中途出现的 state 符号链接写出（已有用户 Hook 配置）', async () => {
  const home = await makeHome()
  const userConfig = await seedUserHooks(home)
  const outside = await mkdtemp(join(tmpdir(), 'zcode-bridge-backup-link-'))
  const fixture = join(home, 'backup-link-preload.cjs')
  await writeFile(
    fixture,
    `const fs = require('node:fs')
const cpSync = fs.cpSync
let done = false
fs.cpSync = function (src, dest, opts) {
  const result = cpSync.call(this, src, dest, opts)
  if (!done && typeof dest === 'string' && dest.includes('.zcode/skills/codex-callback-bridge')) {
    done = true
    fs.mkdirSync(require('node:path').dirname(process.env.LATE_STATE_LINK), { recursive: true })
    fs.symlinkSync(process.env.LATE_STATE_TARGET, process.env.LATE_STATE_LINK, 'dir')
  }
  return result
}`,
  )
  const result = runSetup(['--yes'], home, {
    env: {
      LATE_STATE_LINK: join(home, '.codex/state'),
      LATE_STATE_TARGET: outside,
      NODE_OPTIONS: `--require ${fixture}`,
    },
  })
  assert.notEqual(result.status, 0, '备份写入前发现边界变化必须安全停止')
  assert.equal(readdirSync(outside).length, 0, '外部目录不得有任何新增写入（含备份目录）')
  assert.deepEqual(JSON.parse(readSync(pathsIn(home).hooksConfig)), userConfig, '用户 Hook 配置必须原样保留')
  assert.equal(existsSync(pathsIn(home).manifest), false)
  assert.match(result.stdout + result.stderr, /符号链接|拒绝|失败/)
})

test('复制未完成期间的用户新内容不得被清理', async () => {
  const home = await makeHome()
  const p = pathsIn(home)
  const userBytes = '#!/usr/bin/env python3\n# USER_SAVED_DURING_FAILED_COPY\n'
  const fixture = join(home, 'user-save-preload.cjs')
  await writeFile(
    fixture,
    `const fs = require('node:fs')
const copyFileSync = fs.copyFileSync
fs.copyFileSync = function (src, dest, ...rest) {
  if (process.env.PARTIAL_GUARD_FAIL === '1' && String(dest) === process.env.GUARD_DEST && String(src).endsWith('scripts/zcode_ui_guard.py')) {
    if (process.env.USER_SAVE_BYTES) fs.writeFileSync(dest, process.env.USER_SAVE_BYTES, { mode: 0o644 })
    else fs.writeFileSync(dest, String(fs.readFileSync(String(src))).slice(0, 120), { mode: 0o644 })
    const error = new Error('injected EIO during partial copy')
    error.code = 'EIO'
    throw error
  }
  return copyFileSync.call(this, src, dest, ...rest)
}`,
  )
  const result = runSetup(['--yes'], home, {
    env: {
      PARTIAL_GUARD_FAIL: '1',
      GUARD_DEST: p.guard,
      USER_SAVE_BYTES: userBytes,
      NODE_OPTIONS: `--require ${fixture}`,
    },
  })
  assert.notEqual(result.status, 0)
  assert.equal(readSync(p.guard), userBytes, '复制未完成且归属未知时，用户新保存的字节必须保留')
  assert.match(result.stdout + result.stderr, /人工|保留|未/)
})

test('对照：无法归属的复制残余保守保留并如实报告恢复未完成', async () => {
  const home = await makeHome()
  const p = pathsIn(home)
  const fixture = join(home, 'partial-residue-preload.cjs')
  await writeFile(
    fixture,
    `const fs = require('node:fs')
const copyFileSync = fs.copyFileSync
fs.copyFileSync = function (src, dest, ...rest) {
  if (process.env.PARTIAL_GUARD_FAIL === '1' && String(dest) === process.env.GUARD_DEST && String(src).endsWith('scripts/zcode_ui_guard.py')) {
    fs.writeFileSync(dest, String(fs.readFileSync(String(src))).slice(0, 120), { mode: 0o644 })
    const error = new Error('injected EIO during partial copy')
    error.code = 'EIO'
    throw error
  }
  return copyFileSync.call(this, src, dest, ...rest)
}`,
  )
  const result = runSetup(['--yes'], home, {
    env: {
      PARTIAL_GUARD_FAIL: '1',
      GUARD_DEST: p.guard,
      NODE_OPTIONS: `--require ${fixture}`,
    },
  })
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(p.guard), true, '无法证明归属的残余保守保留（新安全契约）')
  assert.match(result.stdout + result.stderr, /未完全|人工|保留/)
  assert.match(result.stdout + result.stderr, /回滚未完全完成|需要人工核对/)
})
