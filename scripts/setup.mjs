#!/usr/bin/env node
// 中文安装引导：仅使用 Node 标准库，不下载依赖、不请求 sudo。
// 契约：一条命令完成 预览→确认→安装→自检；写入前精确预览并要求明确确认；
// 非交互且未给显式授权绝不写入；写入时重新核验计划，过期计划不得覆盖用户文件；
// Hook 配置写在用户级 $CODEX_HOME/hooks.json；只写入/回滚安装清单记录的、属于本次安装的文件；
// 回滚前核验现场归属，不丢失并发修改，不放宽文件 mode；备份持久化并纳入同一事务。
// 运行状态账本（receipt/ledger/锁）永远不在安装写集或回滚集内。模型偏好不在本包预设。
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd']
const FAULT_ENV = 'ZCODE_BRIDGE_SETUP_TEST_FAULT' // 仅供测试注入中途失败，生产无意义
const REQUIRED_NODE_MAJOR = 22

const usage = `用法：node setup.mjs [--yes | --preview | --doctor | --help]

  （无参数）             一条命令完成：预览 → 交互确认（输入 yes）→ 安装 → 自检
  --yes                 非交互环境的显式授权；跳过确认提问，其余流程相同
  --preview             只读预览将要发生的精确变更，不写入
  --doctor              只读自检：文件/配置、宿主加载（未验证）、权限（待人工确认）、端到端（未验证）

安装目标由 HOME 与 CODEX_HOME 决定，不支持任意自定义路径：
  ZCode 侧技能        ~/​.zcode/skills/codex-callback-bridge
  Codex 侧技能        ~/​.agents/skills/orchestrating-coding-workers
  协调入口/清单/备份   $CODEX_HOME/tools、$CODEX_HOME/state（默认 ~/.codex）
  Hook                $CODEX_HOME/hooks.json（用户级，与 config.toml 并列）+ $CODEX_HOME/hooks/zcode_ui_guard.py
首次触发 Hook 时宿主会请求你审查并信任；本安装器不修改信任记录。`

const die = (message, code = 1) => {
  console.error(message)
  process.exit(code)
}

const parseArgs = argv => {
  const out = { mode: 'install' }
  for (const arg of argv) {
    if (arg === '--help') out.mode = 'help'
    else if (arg === '--preview') out.mode = 'preview'
    else if (arg === '--yes') out.yes = true
    else if (arg === '--doctor') out.mode = 'doctor'
    else die(`未知参数：${arg}\n\n${usage}`, 2)
  }
  if (out.yes && out.mode !== 'install') die('--yes 只能与安装命令（无参数）搭配\n\n' + usage, 2)
  return out
}

// POSIX 单引号转义：' → ''
const shQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`

const sha256File = filePath => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256Text = value => sha256Bytes(Buffer.from(String(value), 'utf8'))

const sha256Tree = root => {
  const digest = createHash('sha256')
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else digest.update(`${path.relative(root, full)}\0${sha256File(full)}\n`)
    }
  }
  walk(root)
  return digest.digest('hex')
}

const digestOf = (target, kind) => (kind === 'copy-dir' ? sha256Tree(target) : sha256File(target))

// 深度已存在的最近祖先作为锚点：锚点本身 realpath 化，其下每个组件都不允许是符号链接。
// lexicalBase 保留原始词法路径，用于包含关系判断（真实路径与 $HOME 的词法形式可能不同）。
const realAnchor = base => {
  const absolute = path.resolve(base)
  let probe = absolute
  const rest = []
  for (;;) {
    try {
      return { anchor: fs.realpathSync(probe), rest, lexicalBase: absolute }
    } catch {
      rest.unshift(path.basename(probe))
      const parent = path.dirname(probe)
      if (parent === probe) die(`无法定位 ${base} 的真实锚点`, 1)
      probe = parent
    }
  }
}

// 统一路径安全检查：目标必须在锚点之下，且从锚点到目标的每一级都不是符号链接。
const pathSafetyError = (anchorInfo, targetPath) => {
  const rel = path.relative(anchorInfo.lexicalBase, path.resolve(targetPath))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return `目标路径不在 ${anchorInfo.lexicalBase} 之下：${targetPath}`
  }
  let cursor = anchorInfo.anchor
  for (const part of [...anchorInfo.rest, ...rel.split(path.sep)]) {
    cursor = path.join(cursor, part)
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return `目标路径包含符号链接，拒绝写入：${cursor}`
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
  }
  return null
}

const containsSegment = (targetPath, segment) => path.resolve(targetPath).split(path.sep).includes(segment)

const canonicalHookEntry = (event, guardPath) => {
  const hook = { type: 'command', command: `python3 ${shQuote(guardPath)}`, timeout: event === 'PreToolUse' ? 5 : 3 }
  return event === 'PreToolUse' || event === 'PostToolUse' ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }
}

// 本包条目识别：guard 文件名是包内唯一标识，任何引用形式（含 shell 转义后的路径）都算本包条目；
// 不能用未经转义的完整路径做包含判断——路径含单引号时 shQuote 转义会把它打散。
const entryReferencesOwnGuard = entry => JSON.stringify(entry).includes('zcode_ui_guard.py')

const validateHookConfigShape = value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '顶层必须是 JSON 对象'
  if (value.hooks !== undefined) {
    if (typeof value.hooks !== 'object' || value.hooks === null || Array.isArray(value.hooks)) return 'hooks 必须是对象'
    for (const [event, entries] of Object.entries(value.hooks)) {
      if (!Array.isArray(entries)) return `hooks.${event} 必须是数组`
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return `hooks.${event} 的条目必须是对象`
        if (entry.matcher !== undefined && typeof entry.matcher !== 'string') return `hooks.${event} 的 matcher 必须是字符串`
        if (!Array.isArray(entry.hooks)) return `hooks.${event} 的条目缺少 hooks 数组`
        for (const hook of entry.hooks) {
          if (typeof hook !== 'object' || hook === null) return `hooks.${event} 的 hook 必须是对象`
          if (typeof hook.command !== 'string') return `hooks.${event} 的 hook.command 必须是字符串`
        }
      }
    }
  }
  return null
}

const readManifest = manifestPath => {
  if (!fs.existsSync(manifestPath)) return { targets: [] }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return { error: '安装清单无法解析（可能已损坏）；为避免误判归属，拒绝继续。' }
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.targets)) {
    return { error: '安装清单结构无法识别；为避免误判归属，拒绝继续。' }
  }
  return parsed
}

const buildLayout = () => {
  const home = os.homedir()
  const codexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== '' ? path.resolve(process.env.CODEX_HOME) : path.join(home, '.codex')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const layout = {
    root,
    home,
    codexHome,
    homeAnchor: realAnchor(home),
    codexAnchor: realAnchor(codexHome),
    bridgeSource: path.join(root, 'skills/codex-callback-bridge'),
    orchestratorSource: path.join(root, 'skills/orchestrating-coding-workers'),
    coordinatorSource: path.join(root, 'scripts/coordinator-run-v1.mjs'),
    guardSource: path.join(root, 'scripts/zcode_ui_guard.py'),
    bridgeDest: path.join(home, '.zcode/skills/codex-callback-bridge'),
    orchestratorDest: path.join(home, '.agents/skills/orchestrating-coding-workers'),
    coordinatorDest: path.join(codexHome, 'tools/coordinator-run-v1.mjs'),
    guardDest: path.join(codexHome, 'hooks/zcode_ui_guard.py'),
    hooksConfig: path.join(codexHome, 'hooks.json'),
    manifest: path.join(codexHome, 'state/zcode-bridge-install.json'),
  }
  layout.reconcileEntry = path.join(layout.bridgeDest, 'scripts/reconcile.mjs')
  layout.backupRoot = path.join(codexHome, 'state')
  return layout
}

const layoutSafetyErrors = layout => {
  const errors = []
  const writePaths = [
    ['ZCode 侧技能', layout.bridgeDest, 'home'],
    ['Codex 侧技能', layout.orchestratorDest, 'home'],
    ['协调端入口', layout.coordinatorDest, 'codex'],
    ['UI guard 脚本', layout.guardDest, 'codex'],
    ['Hook 配置', layout.hooksConfig, 'codex'],
    ['安装清单', layout.manifest, 'codex'],
  ]
  for (const [label, target, anchor] of writePaths) {
    const error = pathSafetyError(anchor === 'codex' ? layout.codexAnchor : layout.homeAnchor, target)
    if (error) errors.push(`【${label}】${error}`)
    if (containsSegment(target, 'zcode-runs')) errors.push(`【${label}】目标不得位于运行账本目录 zcode-runs 内：${target}`)
  }
  for (let i = 0; i < writePaths.length; i += 1) {
    for (let j = i + 1; j < writePaths.length; j += 1) {
      const rel = path.relative(writePaths[i][1], writePaths[j][1])
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        errors.push(`安装目标重叠：${writePaths[i][1]} 与 ${writePaths[j][1]}`)
      }
    }
  }
  return errors
}

const buildPlan = (layout, manifest) => {
  const items = []
  const refusals = [...layoutSafetyErrors(layout)]
  const manifestTargets = manifest.targets ?? []
  const ownedBy = targetPath => manifestTargets.find(entry => entry.path === targetPath)

  const planCopyTarget = plan => {
    if (refusals.length > 0) return
    if (!fs.existsSync(plan.source)) {
      refusals.push(`【${plan.label}】仓库源缺失：${plan.source}`)
      return
    }
    const safety = pathSafetyError(plan.anchor === 'codex' ? layout.codexAnchor : layout.homeAnchor, plan.dest)
    if (safety) {
      refusals.push(`【${plan.label}】${safety}`)
      return
    }
    if (!fs.existsSync(plan.dest)) {
      items.push({ ...plan, action: 'create' })
      return
    }
    const owned = ownedBy(plan.dest)
    if (!owned) {
      refusals.push(`【${plan.label}】目标已存在但不属于本包（安装清单无记录），拒绝覆盖：${plan.dest}。请人工确认后移走它。`)
      return
    }
    let currentDigest
    try {
      currentDigest = digestOf(plan.dest, plan.kind)
    } catch {
      refusals.push(`【${plan.label}】目标与安装时类型不一致，拒绝覆盖：${plan.dest}`)
      return
    }
    if (currentDigest !== owned.digest) {
      refusals.push(`【${plan.label}】目标内容与安装清单不符（可能被你修改过），拒绝静默覆盖：${plan.dest}。请先人工确认/备份这份改动。`)
      return
    }
    if (currentDigest === digestOf(plan.source, plan.kind)) items.push({ ...plan, action: 'skip' })
    else items.push({ ...plan, action: 'backup-refresh' })
  }

  planCopyTarget({ kind: 'copy-dir', anchor: 'home', label: 'ZCode 侧回传桥技能（worker 加载）', source: layout.bridgeSource, dest: layout.bridgeDest })
  planCopyTarget({ kind: 'copy-dir', anchor: 'home', label: 'Codex 侧编排技能（调度端加载）', source: layout.orchestratorSource, dest: layout.orchestratorDest })
  planCopyTarget({ kind: 'copy-file', anchor: 'codex', label: '协调端入口（固定绝对路径调用）', source: layout.coordinatorSource, dest: layout.coordinatorDest })
  planCopyTarget({ kind: 'copy-file', anchor: 'codex', label: 'UI guard Hook 脚本', source: layout.guardSource, dest: layout.guardDest })

  const hooksConfig = layout.hooksConfig
  if (refusals.length === 0) {
    const safety = pathSafetyError(layout.codexAnchor, hooksConfig)
    if (safety) refusals.push(`【Hook 配置】${safety}`)
    else if (!fs.existsSync(hooksConfig)) {
      items.push({ kind: 'hooks', label: `Hook 配置（新建，用户级 ${path.relative(layout.codexHome, hooksConfig) || 'hooks.json'}）`, dest: hooksConfig, action: 'create-hooks', events: HOOK_EVENTS })
    } else {
      let parsed
      try {
        parsed = JSON.parse(fs.readFileSync(hooksConfig, 'utf8'))
      } catch {
        refusals.push(`【Hook 配置】无法解析（不是合法 JSON），拒绝合并，请先人工修复：${hooksConfig}`)
        parsed = undefined
      }
      if (parsed !== undefined) {
        const shapeError = validateHookConfigShape(parsed)
        if (shapeError) refusals.push(`【Hook 配置】结构无法识别（${shapeError}），拒绝合并，请先人工确认：${hooksConfig}`)
        else {
          const pendingEvents = []
          let touched = false
          for (const event of HOOK_EVENTS) {
            const canonical = canonicalHookEntry(event, layout.guardDest)
            const entries = parsed.hooks?.[event] ?? []
            const ours = entries.filter(entry => entryReferencesOwnGuard(entry))
            if (ours.length > 1) refusals.push(`【Hook 配置】${event} 存在多条本包 guard 条目，请先人工清理：${hooksConfig}`)
            else if (ours.length === 1) {
              if (JSON.stringify(ours[0]) !== JSON.stringify(canonical)) {
                refusals.push(`【Hook 配置】${event} 的本包 guard 条目已被修改，拒绝静默覆盖：${hooksConfig}`)
              }
            } else {
              pendingEvents.push(event)
              touched = true
            }
          }
          if (pendingEvents.length > 0) items.push({ kind: 'hooks', label: 'Hook 配置（合并追加）', dest: hooksConfig, action: 'append-hooks', events: pendingEvents })
          else if (!touched) items.push({ kind: 'hooks', label: 'Hook 配置', dest: hooksConfig, action: 'skip-hooks', events: [] })
        }
      }
    }
  }

  return { items, refusals }
}

const planFingerprint = plan =>
  sha256Text(
    JSON.stringify({
      refusals: plan.refusals,
      items: plan.items.map(item => ({ kind: item.kind, dest: item.dest, action: item.action, events: item.events ?? null })),
    }),
  )

const describeAction = item => {
  if (item.action === 'create') return '新建'
  if (item.action === 'backup-refresh') return '备份后更新'
  if (item.action === 'create-hooks') return '新建 Hook 配置并写入 5 条事件'
  if (item.action === 'append-hooks') return `追加 Hook 条目：${item.events.join(' / ')}`
  return '跳过（已是最新，无需写入）'
}

const printPreview = (layout, plan) => {
  console.log('ZCode Codex 回传桥 · 安装预览（只读，尚未写入任何文件）')
  console.log(`来源仓库：${layout.root}`)
  console.log(`目标主目录：HOME=${layout.home}  CODEX_HOME=${layout.codexHome}`)
  plan.items.forEach((item, index) => {
    console.log(` ${index + 1}. [${describeAction(item)}] ${item.label}`)
    if (item.kind === 'hooks') console.log(`    目标：${item.dest}`)
    else console.log(`    ${item.source}\n    → ${item.dest}`)
  })
  console.log(`Hook 命令示例：${canonicalHookEntry('PreToolUse', layout.guardDest).hooks[0].command}（PreToolUse 超时 5s，其余 3s）`)
  if (plan.refusals.length > 0) {
    console.log('\n【已拒绝，未写入任何文件】以下问题需要你先人工处理：')
    for (const refusal of plan.refusals) console.log(` ✗ ${refusal}`)
  }
}

const confirmInteractive = async () => {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question('\n确认按预览写入以上变更？输入 yes 继续，其他任意输入取消：')).trim()
    rl.close()
    return answer === 'yes'
  }
  return null
}

const writeAtomically = (dest, bytes, mode) => {
  const temporary = `${dest}.${process.pid}.tmp`
  fs.writeFileSync(temporary, bytes, { mode })
  fs.renameSync(temporary, dest)
  try {
    fs.chmodSync(dest, mode)
  } catch {}
}

const copyDirSync = (source, dest) => fs.cpSync(source, dest, { recursive: true, errorOnExist: true, force: false })

const currentMode = targetPath => {
  try {
    return fs.statSync(targetPath).mode & 0o777
  } catch {
    return null
  }
}

// 回滚：先核验现场仍等于本次写入的内容，才允许恢复/删除；
// 不匹配说明有并发修改，保留现场并如实报告，绝不覆盖，也绝不误报“已恢复”。
// 每次恢复前重验路径边界：目标或祖先中途变为符号链接时不得沿链接写入。
const rollback = (journal, layout) => {
  console.log('\n安装中途失败，正在按归属核验并回滚本次安装写入的内容……')
  let allRestored = true
  const boundaryGuard = entry => {
    const anchorInfo = entry.anchor === 'codex' ? layout.codexAnchor : layout.homeAnchor
    const error = pathSafetyError(anchorInfo, entry.dest)
    if (error) {
      allRestored = false
      console.log(` ✗ 未恢复（${error}），已保留现场，请人工核对：${entry.dest}`)
      return false
    }
    return true
  }
  for (const entry of [...journal].reverse()) {
    try {
      if (entry.type === 'hooks') {
        if (!boundaryGuard(entry)) continue
        const current = fs.existsSync(entry.dest) ? sha256File(entry.dest) : null
        if (current !== entry.writtenSha && current !== null) {
          allRestored = false
          console.log(` ✗ 未恢复（检测到本次写入之后的并发修改，已保留现场，请人工核对）：${entry.dest}`)
          continue
        }
        if (entry.backupPath) {
          if (!fs.existsSync(entry.backupPath)) {
            allRestored = false
            console.log(` ✗ 未恢复（可核验备份缺失，请人工核对）：${entry.dest}`)
            continue
          }
          fs.copyFileSync(entry.backupPath, entry.dest)
          if (entry.previousMode !== null) fs.chmodSync(entry.dest, entry.previousMode)
        } else {
          fs.rmSync(entry.dest, { force: true })
        }
        console.log(` ✓ 已恢复：${entry.dest}`)
      } else {
        if (!boundaryGuard(entry)) continue
        const current = fs.existsSync(entry.dest) ? digestOf(entry.dest, entry.kind) : null
        if (entry.installedDigest !== null && current !== null && current !== entry.installedDigest) {
          allRestored = false
          console.log(` ✗ 未恢复（检测到本次写入之后的并发修改，已保留现场，请人工核对）：${entry.dest}`)
          continue
        }
        if (entry.backupPath) {
          // 复制未完成且目标已有内容时，无法证明归属：保守保留，不得当作清理权限
          if (entry.installedDigest === null && current !== null) {
            allRestored = false
            console.log(` ✗ 未恢复（复制未完成且目标已有内容、无法确认归属，已保留现场与备份，请人工核对）：${entry.dest}`)
            continue
          }
          if (!fs.existsSync(entry.backupPath)) {
            allRestored = false
            console.log(` ✗ 未恢复（可核验备份缺失，请人工核对）：${entry.dest}`)
            continue
          }
          fs.rmSync(entry.dest, { recursive: true, force: true })
          if (entry.kind === 'copy-dir') copyDirSync(entry.backupPath, entry.dest)
          else fs.copyFileSync(entry.backupPath, entry.dest)
        } else if (entry.installedDigest === null) {
          // 无备份的未完成复制：目标存在即无法证明归属，保守保留并如实报告恢复未完成
          if (current !== null) {
            allRestored = false
            console.log(` ✗ 未恢复（复制未完成且无法确认目标内容归属，已保守保留现场，请人工核对）：${entry.dest}`)
            continue
          }
          console.log(` ✓ 已恢复：${entry.dest}（无残余）`)
        } else {
          fs.rmSync(entry.dest, { recursive: true, force: true })
          console.log(` ✓ 已恢复：${entry.dest}`)
        }
      }
    } catch (error) {
      allRestored = false
      console.log(` ✗ 回滚失败（请人工检查）：${entry.dest}（${error.message}）`)
    }
  }
  for (const dir of [...journal.createdDirs].reverse()) {
    try {
      fs.rmdirSync(dir)
    } catch {
      // 目录非空或不属于本次安装创建时保留，不强删
    }
  }
  if (journal.backupDir && fs.existsSync(journal.backupDir)) {
    console.log(`本次备份目录已保留供核验：${journal.backupDir}`)
  }
  if (allRestored) {
    console.log('回滚完成：仅处理本次安装拥有的文件；运行账本/receipt/锁从未被触碰。')
  } else {
    console.log('回滚未完全完成：以上标注 ✗ 的文件已保留现场，需要人工核对，运行账本/receipt/锁从未被触碰。')
  }
  return allRestored
}

const ensureParent = (dest, journal) => {
  const parent = path.dirname(dest)
  const created = []
  let cursor = parent
  while (!fs.existsSync(cursor)) {
    created.unshift(cursor)
    cursor = path.dirname(cursor)
  }
  for (const dir of created) fs.mkdirSync(dir, { recursive: true })
  journal.createdDirs.push(...created)
}

const preconditionError = item => {
  if (item.action === 'create' && fs.existsSync(item.dest)) return `目标在确认后新出现了内容，过期计划不得覆盖：${item.dest}`
  return null
}

const performApply = async (layout, plan, previewFingerprint, args) => {
  if (plan.refusals.length > 0) {
    printPreview(layout, plan)
    die('\n存在未解决的拒绝项，本次未写入任何文件。', 1)
  }
  if (!args.yes) {
    const confirmed = await confirmInteractive()
    if (confirmed === null) die('未交互且未给显式授权：不会写入。在交互终端直接运行本命令进行确认，或加 --yes 显式授权。', 1)
    if (!confirmed) die('已取消：未写入任何文件。', 1)
  }

  // 确认后重新核验：计划若已过期（目标出现/变化），绝不按旧计划写入。
  const manifestNow = readManifest(layout.manifest)
  if (manifestNow.error) die(manifestNow.error, 1)
  const rebuilt = buildPlan(layout, manifestNow)
  if (planFingerprint(rebuilt) !== previewFingerprint) {
    console.log('\n【计划已过期】确认期间安装目标发生了变化，本次未写入任何文件。以下是最新的计划，请重新确认：\n')
    printPreview(layout, rebuilt)
    process.exit(1)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const journal = []
  journal.createdDirs = []
  journal.backupDir = path.join(layout.backupRoot, `zcode-bridge-install-backup-${stamp}`)
  let wroteAnything = false
  try {
    for (const item of plan.items) {
      if (item.action === 'skip' || item.action === 'skip-hooks') continue
      wroteAnything = true
      const stale = preconditionError(item)
      if (stale) throw new Error(stale)
      if (item.kind === 'hooks') {
        const hooksBoundary = pathSafetyError(layout.codexAnchor, item.dest)
        if (hooksBoundary) throw new Error(`写入前边界核验失败：${hooksBoundary}`)
        const existed = fs.existsSync(item.dest)
        const previousMode = currentMode(item.dest)
        const previousBytes = existed ? fs.readFileSync(item.dest) : null
        const config = previousBytes === null ? {} : JSON.parse(previousBytes.toString('utf8'))
        config.hooks = config.hooks ?? {}
        for (const event of item.events) {
          const canonical = canonicalHookEntry(event, layout.guardDest)
          const entries = config.hooks[event] ?? []
          if (!entries.some(entry => JSON.stringify(entry) === JSON.stringify(canonical))) entries.push(canonical)
          config.hooks[event] = entries
        }
        const mergedBytes = Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8')
        let backupPath = null
        if (existed) {
          const backupBoundary = pathSafetyError(layout.codexAnchor, journal.backupDir)
          if (backupBoundary) throw new Error(`写入前边界核验失败：${backupBoundary}`)
          fs.mkdirSync(journal.backupDir, { recursive: true })
          backupPath = path.join(journal.backupDir, `${path.basename(item.dest)}.${stamp}`)
          fs.copyFileSync(item.dest, backupPath)
        }
        ensureParent(item.dest, journal)
        writeAtomically(item.dest, mergedBytes, previousMode ?? 0o600)
        journal.push({ type: 'hooks', dest: item.dest, backupPath, previousMode, writtenSha: sha256Bytes(mergedBytes), anchor: 'codex' })
        continue
      }
      const boundaryError = pathSafetyError(item.anchor === 'codex' ? layout.codexAnchor : layout.homeAnchor, item.dest)
      if (boundaryError) throw new Error(`写入前边界核验失败：${boundaryError}`)
      ensureParent(item.dest, journal)
      let backupPath = null
      const existed = fs.existsSync(item.dest)
      if (existed) {
        const backupBoundary = pathSafetyError(layout.codexAnchor, journal.backupDir)
        if (backupBoundary) throw new Error(`写入前边界核验失败：${backupBoundary}`)
        fs.mkdirSync(journal.backupDir, { recursive: true })
        backupPath = path.join(journal.backupDir, `${path.basename(item.dest)}.${stamp}`)
        if (item.kind === 'copy-dir') copyDirSync(item.dest, backupPath)
        else fs.copyFileSync(item.dest, backupPath)
      }
      // 先登记后动手：替换/复制在任何切口失败，回滚都能看到该目标
      const journalEntry = { type: 'install', kind: item.kind, dest: item.dest, backupPath, installedDigest: null, anchor: item.anchor }
      journal.push(journalEntry)
      if (existed) fs.rmSync(item.dest, { recursive: true, force: true })
      if (item.kind === 'copy-dir') copyDirSync(item.source, item.dest)
      else fs.copyFileSync(item.source, item.dest)
      journalEntry.installedDigest = digestOf(item.dest, item.kind)
      if (process.env[FAULT_ENV] === 'before-hooks-merge' && item.kind === 'copy-file' && item.dest === layout.guardDest) {
        throw new Error(`${FAULT_ENV} 注入的测试故障：模拟 Hook 合并前中断`)
      }
    }
    if (process.env[FAULT_ENV] === 'before-manifest') {
      throw new Error(`${FAULT_ENV} 注入的测试故障：模拟清单发布前中断`)
    }
    if (wroteAnything || !fs.existsSync(layout.manifest)) {
      const manifestBoundary = pathSafetyError(layout.codexAnchor, layout.manifest)
      if (manifestBoundary) throw new Error(`写入前边界核验失败：${manifestBoundary}`)
      const targets = plan.items.map(item =>
        item.kind === 'hooks'
          ? { path: item.dest, kind: 'hooks', events: HOOK_EVENTS, guard: layout.guardDest }
          : { path: item.dest, kind: item.kind, digest: digestOf(item.dest, item.kind) },
      )
      ensureParent(layout.manifest, journal)
      writeAtomically(
        layout.manifest,
        JSON.stringify({ version: 2, installedAt: new Date().toISOString(), root: layout.root, targets }, null, 2) + '\n',
        0o600,
      )
    }
  } catch (error) {
    console.error(`\n✗ 安装失败：${error.message}`)
    rollback(journal, layout)
    process.exit(1)
  }

  console.log('\n✅ 安装完成。已写入的路径见安装清单：' + layout.manifest)
  console.log('\n对账绑定（reconcile-receipt / review-holder 必需）。推荐按命令内联，不要求改 shell rc：')
  console.log(`   ZCODE_CALLBACK_BRIDGE_RECONCILE=${shQuote(layout.reconcileEntry)} node ${shQuote(layout.coordinatorDest)} <命令> '<json 配置>'`)
  console.log(`   export ZCODE_CALLBACK_BRIDGE_RECONCILE=${shQuote(layout.reconcileEntry)}`)
  console.log('模型由你在派发配置中显式选择（zcodeModel）；本包不预设模型，也不把任何偏好写进发行包。')
  console.log('提醒：安装不等于任务授权。宿主首次触发 Hook 时会请求你审查并信任；本安装器不修改信任记录。')
  console.log('\n正在运行自检（--doctor）……\n')
  return runDoctor(layout)
}

const runDoctor = layout => {
  const checks = []
  const check = (name, pass, detail) => {
    checks.push(pass)
    console.log(` ${pass ? '✓' : '✗'} ${name}：${detail}`)
  }

  console.log('【1/4 文件与配置检查】（以下为脚本可直接验证的部分；失败时退出码非 0）')
  const nodeMajor = Number(process.versions.node.split('.')[0])
  check(
    'Node.js',
    nodeMajor >= REQUIRED_NODE_MAJOR,
    `实测 ${process.version}；本包要求 ≥ ${REQUIRED_NODE_MAJOR}${nodeMajor >= REQUIRED_NODE_MAJOR ? '' : ` —— 请先升级 Node.js 再安装（本工具不代装）`}`,
  )
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  check(
    'Python 3',
    python.status === 0,
    python.status === 0 ? `python3 可用（${(python.stdout + python.stderr).trim()}），UI guard 依赖它` : '未找到 python3 —— UI guard 及其 Hook 无法运行；请先安装 Python 3（不要用本工具自动安装）',
  )
  const manifest = readManifest(layout.manifest)
  const manifestOk = !manifest.error && fs.existsSync(layout.manifest)
  if (manifest.error) check('安装清单', false, manifest.error)
  else if (!manifestOk) check('安装清单', false, `未找到 ${layout.manifest} —— 尚未安装或已移除；直接运行本命令可查看安装计划`)
  else check('安装清单', true, layout.manifest)

  const installedTargets = [
    ['回传桥技能（ZCode 侧）', layout.bridgeDest],
    ['编排技能（Codex 侧）', layout.orchestratorDest],
    ['协调端入口', layout.coordinatorDest],
    ['UI guard 脚本', layout.guardDest],
  ]
  for (const [name, target] of installedTargets) {
    if (!fs.existsSync(target)) check(name, false, `缺失：${target}`)
    else {
      const owned = manifestOk ? (manifest.targets ?? []).find(entry => entry.path === target) : undefined
      if (!owned) check(name, false, `存在但没有安装清单归属记录：${target}（可能不是本包安装的）`)
      else if (owned.digest !== undefined && owned.digest !== digestOf(target, owned.kind)) {
        check(name, false, `内容与安装清单不符（可能被修改）：${target}`)
      } else check(name, true, target)
    }
  }
  if (!fs.existsSync(layout.hooksConfig)) check('Hook 配置', false, `缺失：${layout.hooksConfig}`)
  else {
    try {
      const parsed = JSON.parse(fs.readFileSync(layout.hooksConfig, 'utf8'))
      const shapeError = validateHookConfigShape(parsed)
      if (shapeError) check('Hook 配置', false, `${shapeError}：${layout.hooksConfig}`)
      else {
        const missing = HOOK_EVENTS.filter(event => {
          const canonical = canonicalHookEntry(event, layout.guardDest)
          return !((parsed.hooks?.[event] ?? []).some(entry => JSON.stringify(entry) === JSON.stringify(canonical)))
        })
        check('Hook 配置', missing.length === 0, missing.length === 0 ? `5 个事件均已含本包 guard 条目：${layout.hooksConfig}` : `缺少事件条目：${missing.join(' / ')}（${layout.hooksConfig}）`)
      }
    } catch {
      check('Hook 配置', false, `无法解析：${layout.hooksConfig}`)
    }
  }
  const reconcilePath = process.env.ZCODE_CALLBACK_BRIDGE_RECONCILE
  if (reconcilePath === undefined || reconcilePath.trim() === '') {
    console.log(` ⚠ 未设置全局 ZCODE_CALLBACK_BRIDGE_RECONCILE（可选项，不影响本项结论）。对账命令可用内联前缀：`)
    console.log(`   ZCODE_CALLBACK_BRIDGE_RECONCILE=${shQuote(layout.reconcileEntry)} node ${shQuote(layout.coordinatorDest)} reconcile-receipt '<json>'`)
  } else if (!fs.existsSync(reconcilePath)) {
    check('对账绑定 ZCODE_CALLBACK_BRIDGE_RECONCILE', false, `指向的文件不存在：${reconcilePath}`)
  } else {
    console.log(` ⚠ ZCODE_CALLBACK_BRIDGE_RECONCILE 已设置：${reconcilePath}（脚本只检查存在性，不校验来源可信性）`)
  }

  console.log('\n【2/4 宿主实际加载：未验证】')
  console.log(' 本工具无法证明 ZCode/Codex 宿主已加载技能或 Hook。请打开两端客户端确认技能列表可见；宿主首次触发 Hook 时会请求你审查并信任，由你在客户端中批准。')
  console.log('\n【3/4 系统权限：待人工确认】')
  console.log(' macOS 辅助功能/自动化权限无法由脚本授予，也不能被脚本证明。请到 系统设置 → 隐私与安全性 → 辅助功能/自动化 中人工确认相关应用已获授权。')
  console.log('\n【4/4 端到端回传：未验证】')
  console.log(' 只有完成一次真实派发→执行→回传→验收闭环才能证明回传可用；本工具不会替你宣称这一点。')

  const passed = checks.filter(Boolean).length
  const total = checks.length
  const ok = passed === total
  console.log(`\n文件/配置检查：${passed}/${total} 通过 —— 结论：${ok ? '基础安装完整；其余三项边界仍需按上面说明人工确认' : '基础安装不完整，请先处理上面的 ✗ 项'}`)
  return ok ? 0 : 1
}

const args = parseArgs(process.argv.slice(2))
if (args.mode === 'help') {
  console.log(usage)
  process.exit(0)
}

const layout = buildLayout()
for (const source of [layout.bridgeSource, layout.orchestratorSource, layout.coordinatorSource, layout.guardSource]) {
  if (!fs.existsSync(source)) die(`仓库源缺失，无法继续：${source}`, 1)
}

if (args.mode === 'doctor') process.exit(runDoctor(layout))

const manifest = readManifest(layout.manifest)
if (manifest.error) die(manifest.error, 1)
const plan = buildPlan(layout, manifest)
printPreview(layout, plan)

if (args.mode === 'preview') {
  if (plan.refusals.length > 0) process.exit(1)
  console.log('\n这只是预览，未写入任何文件。')
  process.exit(0)
}

process.exitCode = await performApply(layout, plan, planFingerprint(plan), args)
