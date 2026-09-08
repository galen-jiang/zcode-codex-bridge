# zcode-codex-bridge

将 ZCode 桌面编码代理接入 Codex 任务流的回传桥与编排技能集合：worker 完成工作后，通过受控回执（receipt）、有界回传投递（delivery）与协调端对账兜底（reconcile）形成可审计的闭环。包含两个技能与配套脚本；CLI worker 的编排不等于具有桌面自动回传能力。

> 本项目按“现状”发布，不承诺官方支持、无人值守可靠送达或跨平台验证；仅在作者环境（macOS）验证过。

## 前提

- macOS（依赖 macOS 辅助功能/自动化权限的 Computer Use 回传路径）
- 已安装并登录 ZCode 桌面版与 Codex 桌面版
- Node.js 22（本次验证版本；仅标准库，无第三方依赖）
- Python 3（仅标准库，用于 UI guard 及其测试）
- 你的 ZCode/Codex 客户端需支持对应的 UI 自动化入口；技能文档中涉及 CUA 的说明以随包 `scripts/zcode_ui_guard.py` 实际支持为准

## 目录

```
skills/codex-callback-bridge/     回传桥技能（receipt/delivery/reconcile 三入口 + 78 项测试）
skills/orchestrating-coding-workers/  编排技能（派发/验收/续推的协调约定）
scripts/coordinator-run-v1.mjs    协调端状态机（账本创建、派发、验收、对账）
scripts/zcode_ui_guard.py         UI 操作守卫（Hook 集成）
tests/guard/                      guard 的 Python 测试
```

## 安装

1. `skills/codex-callback-bridge/` 复制到 **ZCode 侧**技能目录（如 `~/.zcode/skills/`）——回传桥由 ZCode worker 加载。
2. `skills/orchestrating-coding-workers/` 复制到 **Codex 调度端**可发现的技能目录，例如 `~/.agents/skills/`。两端角色不同，请分别安装并确认客户端能加载。
3. 保留 `scripts/coordinator-run-v1.mjs` 于固定位置，通过 `node /absolute/path/coordinator-run-v1.mjs <command> '<json-config>'` 调用。状态目录优先级为显式 `config.stateDir`、环境变量 `CODEX_BRIDGE_STATE_DIR`、默认 `~/.codex/state/zcode-runs`；值须为规范化绝对路径且末级目录名为 `zcode-runs`，非法显式值（包括 null）拒绝而不回退。`reconcile-receipt` / `review-holder` 另要求 `ZCODE_CALLBACK_BRIDGE_RECONCILE` 指向已安装 bridge 的 `scripts/reconcile.mjs` 绝对路径。
4. UI guard 复制到 `~/.codex/hooks/zcode_ui_guard.py`，按你现有 Hook 配置**合并**接入（见下），绝不整体覆盖已有 `hooks.json`。这是宿主 Hook 集成，不会因为复制 skill 就自动启用。
5. 模型/路由由安装者显式选择（协调端派发配置使用 `zcodeModel`），本包不预设模型型号。文档中的 `<skills-install-root>` 指实际的 ZCode 技能父目录；所有尖括号都是待替换示例，不是可直接执行的 shell 参数。

`ZCODE_CALLBACK_BRIDGE_RECONCILE` 的绝对路径是安装要求，用于避免调用目录歧义；当前协调脚本仅校验其非空，不自动验证该路径的来源或可信性。

这不是一键任务队列：创建运行需要具体工作区基线、有限授权和回传目标，见编排技能的 `references/autonomous-runs.md` 与脚本入口。只有明确选定的 Task 才能派发，安装不授予任何项目写权限。

## 合并 Hook 配置示例

下面是已核对的宿主结构示例。将命令路径替换为实际绝对路径，按事件追加内部条目；保留已有 Hook。宿主必须提供 `session_id`、`hook_event_name`、`tool_name`、`tool_input` 和 PostToolUse 的 `tool_response`，并执行 guard 返回的拒绝决定。若当前版本不支持此结构或事件，先验证适配，不能宣称互斥已生效。

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "python3 /path/to/zcode_ui_guard.py", "timeout": 5 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "python3 /path/to/zcode_ui_guard.py", "timeout": 3 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "python3 /path/to/zcode_ui_guard.py", "timeout": 3 }] }],
    "Interrupt": [{ "hooks": [{ "type": "command", "command": "python3 /path/to/zcode_ui_guard.py", "timeout": 3 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "python3 /path/to/zcode_ui_guard.py", "timeout": 3 }] }]
  }
}
```

guard 的状态默认在 `~/.codex/state/zcode-ui-lock.json`，可用 `CODEX_ZCODE_UI_STATE_PATH` 覆盖。它对 `mcp__cua_repl.js` / `mcp__cua_repl__js` 的全部调用保守加锁（包括只读调用），另识别受支持的 `sky` 变更调用；不是所有工具/API 的通用互斥。发送调用须带文档指定的中文标记并提供完整发送后 UI 证据，才即时释放；终止事件只释放同 session 的锁。先在隔离环境跑下面的 guard 测试，再检查宿主真实事件接线。

## 卸载 / 回滚

- 先停止相关 writer、后台活动和调度，确认 receipt 不再 active，再移除已复制的两个技能目录与协调端入口文件；
- 从 `hooks.json` 中移除你添加的 guard 条目（只删自己加的部分）；
- 回滚约束：账本状态目录不能无条件整目录覆盖还原——永久 receiver 回执、successor fence 等历史必须保留，且已 `stopped` 的 run 处于防重放终态，停机/回滚也不得回退该状态。只恢复你明确备份且理解其语义的文件，离线静默操作。

## 测试

```sh
# 回传桥全量（78 项，均为临时 fixture，不触真实账本）
CANDIDATE_BRIDGE=<本包>/skills/codex-callback-bridge \
COORDINATOR_CANDIDATE=<协调端入口> \
node --test <本包>/skills/codex-callback-bridge/tests/*.test.mjs

# 隐私扫描（应输出 PRIVACY_SCAN_CLEAN）
node <本包>/scripts/privacy-scan.mjs <本包>

# UI guard（Python；从仓库任意根目录可复现，脚本在 scripts/ 下）
PYTHONPATH=<本包>/scripts python3 -m unittest discover -s <本包>/tests/guard -p "test_*.py" -q

# 默认路径、覆盖优先级、非法输入与扫描器回归
COORDINATOR_CANDIDATE=<本包>/scripts/coordinator-run-v1.mjs \
node --test <本包>/tests/*.test.mjs
```

## 隐私与安全边界

- 账本/回执/锁只写入声明的状态目录；测试只使用隔离临时目录。
- 回执目录是一次性领取（irreversible claim），回传消息必须与验收锚点逐字匹配；未知是否发送过时先只读核验，绝不盲目重发。
- 协调端对账只将已释放的 completed 回执推进到 `reviewing`，绝不直接判定 accepted 或自动续派。
- 隐私扫描器仅做通用启发式检查：用户绝对路径、邮箱和一个既知模型字串；不识别任意真实任务 ID、所有模型偏好、秘密或编码数据。它扫描自身和测试文本，但跳过 `.git`、依赖/缓存目录及部分二进制扩展，不能代替发布对象清单、私有已知值扫描与人工审计。
- 发行内容使用合成任务标识与路径占位符，仅保留许可中的公开作者昵称。分享前仍应独立检查文件名、隐藏文件、历史、日志、邮箱及凭据；不要把私有敏感值清单写入公开扫描器。

## 局限

- 未在 Linux/Windows 验证；Computer Use 路径依赖 macOS。
- 回传采用有界重试与显式发送证据；无法确认是否发送时只读核对，不盲目重发，不承诺 exactly-once。
- UI guard 的闲置接管策略不等同于运行账本/receipt 的永久防重放约束；本包不是抵御恶意本地进程的安全隔离边界。
- 公开 coordinator 没有 active/失联 writer 的强制 terminalization 命令。遇到 receiver 仍 active 或 owner 无法核实时必须保持 checkpoint；不能猜命令、手改 receipt、删锁或重建 run 来继续。完整终止需要部署方另行具备并审查相应恢复工具，本包不提供该能力。
- 恢复需要显式授权的会话触发；没有后台守护进程或自唤醒。

## 许可

MIT，详见 [LICENSE](LICENSE)。
