# ZCode App 操作契约

## 发送前

1. 在 UI 中核验目标项目名与专属对话。提示词中的绝对工作目录不能证明当前对话归属。
2. 读取对话历史，确认上下文属于同一项目和任务。发现其他项目内容就新建目标项目下的独立任务，不复用污染对话。
3. 核验输入框为空、目标模型为 `<installer-configured-model>`、worktree 基线仍与提示词一致。
4. 在 UI 外准备完整提示词。清空草稿和发送消息分别属于有外部影响的 UI 动作，按 Computer Use 规则在动作发生前取得确认。

## 精确文本输入与剪贴板回退

已观察到两类独立故障：`paste` 报 `-10005: Timed out waiting for the application to read the clipboard`；模拟键入在 ZCode 和 TextEdit 中丢失下划线、标点或中文，多行还可能触发提前发送。`setValue` 对富文本 composer 也曾无效。工具返回成功或换一个编辑器，都不构成正文完整的证明。

### 默认路径：落盘文件 → VS Code 原生复制 → ZCode 复读

1. 用文件工具在本任务授权目录写好 UTF-8 纯文本提示词，完整保留换行；以磁盘文件作为 `expected`，记录路径和内容摘要。不要通过 `typeText` / `type_text` 在编辑器或 ZCode 中重建多行正文、中文或协议字段。
2. 用 VS Code 打开该精确文件，在源码编辑区核验文件路径后全选、原生 `Cmd+C`。不要从 Markdown 预览、终端或新建的未保存文稿复制，也不要以编辑器复读值反过来覆盖 `expected`。TextEdit 已有字符损坏反例，不再作为推荐中转；VS Code 也必须通过下面的完整性检查。
3. 在 Hook 保护的 UI 事务内重新核验目标项目、对话、模型与空 composer，真实点击输入框后只执行一次 `Cmd+V`。原生复制会覆盖系统剪贴板；只有事前保存、事后核验过原内容，才能声称已经恢复，不能用历史提示词代替原剪贴板。
4. 从完整 AX/UI 读取结果提取 composer 正文，与磁盘 `expected` 逐字比较，包括下划线、冒号、引号、中文和换行；同时确认源文件未变。不要用 `trim`、忽略标点、只检查 ID/前缀或截图观感放宽比较。内容截断、无法完整读取或存在差异时不得发送；全部一致后才进入发送与发送后验证。

### 超时与降级

- `paste` 超时只说明未确认应用及时读取，不证明输入框为空或消息未发送。捕获错误后先只读核对 composer 与对话末尾；内容完整且未发送才可进入发送门禁，已发送则对账，不重复派发。不得在调用未结束时追加 `Cmd+V`，也不得盲目重试。
- 确认未发送且输入框为空后，直接 `paste` 失败可切换到上述 VS Code 路径一次。部分落地或已有草稿时停止追加；只在已获授权且确认草稿属于本次操作时清除，再重新核验。原生路径仍失败则停止该通道，不循环尝试 TextEdit、`setValue` 或逐行键入。
- 若当前派发允许从本机文件加载，且能核验空 composer，可改用短、单行 ASCII 引导读取同一完整提示词文件。`typeText` 仅用于这种逐字可核验的短引导；不要手敲完整 envelope，也不要假定 ASCII 标点一定可靠。启用回传桥时，文件仍须包含完整 skill 声明、动态 envelope 和 brief 路径；worker 必须先完整读取该文件、加载 skill 并校验 envelope，再 claim 或开展项目活动。引导不是 envelope，不得猜补字段或借此绕过账本、回执和授权。未启用回传桥的派发保持人工通知，不伪造 envelope 或自动回传能力。
- 短引导也必须发送前逐字复读，发送后确认 worker 实际加载了正确文件。路径、读取结果、发送状态或 UI 互斥任一不确定，就停在人工 checkpoint；不创建新 `run_id` 来重试，也不宣称已可靠派发。

## Hook 互斥

全局 Hook 位于 `~/.codex/hooks/zcode_ui_guard.py`，状态位于 `~/.codex/state/zcode-ui-lock.json`。

- 只读 `sky.get_app_state({ app: "ZCode" })` 不占锁。
- 第一个会改变 ZCode 的 `sky` 调用取得锁；每个变更调用必须显式传 `app: "ZCode"`。
- 锁只覆盖导航、输入和发送这一段 UI 事务，不覆盖 ZCode worker 的整个运行期。
- 被 `PreToolUse` 拒绝时等待，不删除锁、不改状态文件、不绕过 Hook。
- 使用不同 Computer Use API 前先核对 Hook 是否实际覆盖该工具；随包 guard 识别 `sky` 变更调用与 `mcp__cua_repl.js`/`mcp__cua_repl__js` 两个 CUA 入口（PreToolUse/PostToolUse）。未列出的工具未被覆盖时暂停 ZCode UI 变更，不能靠只读检查锁文件代替互斥。
- 120 秒无动作的锁可被新会话接管；损坏锁会拒绝接管并要求人工检查。
- `Stop`、`Interrupt`、`SessionEnd` 只释放本会话持有的锁。

## 发送与即时释放

最后一次 `node_repl` 调用应在同一调用里完成发送和发送后读取，并把工具 `title` 精确设为：

```text
发送 ZCode 提示词并验证
```

Hook 只有在工具无错误、窗口仍为 ZCode、输入框已清空，并出现“停止生成”“工作中”“正在思考”或“继续输入以排队后续修改”之一时才立即释放；未满足释放条件则继续持锁至本回合结束。

这些信号只是锁释放条件，不是本次派发成功证明。发送后还须核验正确目标对话中新增的消息，与发送前验证过的正文或短引导一致（skill 引用等 UI 结构须单独核对）；短引导另须确认正确文件已被读取。状态不确定时先只读对账，只有确认未发送后才允许重试，不盲目重发。

## ZCode UI 回传桥

动作主体始终是 ZCode App worker：它调用 ZCode 自带的 Computer Use 操作 Codex 桌面 App；不是 Codex 反向操作 ZCode。只有全局 `~/.zcode/skills/codex-callback-bridge/SKILL.md` 可加载、ZCode 自带 Computer Use 可用、账本派发已持久化且以下动态 envelope 完整时才启用；否则保持人工通知。

完整派发提示词必须以这段内容开头，并替换所有尖括号字段；采用上述文件引导时，这个头部必须位于被读取的完整提示词文件中，不能只给 brief 路径：

```text
/skill codex-callback-bridge

ZCODE_DISPATCH_ENVELOPE_V1
run_id: <lowercase UUID>
dispatch_id: <lowercase UUID>
ledger_path: <absolute .../zcode-runs/<run_id>.json>
tombstone_path: <same directory>/<run_id>.tombstone
receiver_path: <same directory>/<run_id>.<dispatch_id>.receiver
codex_project: <exact visible Codex project name>
codex_task_title: <exact visible Codex task title>
coordinator_task_id: <immutable Codex task ID>
stop_at: <RFC 3339 timestamp with offset>
```

随后给出本 Task 的精确现场、写集、成功标准、验证与 Git 边界。receiver 生命周期、三类精确回传文本、Computer Use 定位与发送后复读规则由全局 skill 统一定义；提示词不得复制一份可漂移的旧协议。worker 在 release 前保持 receipt 为 `active`，不得自行开始下一 Task。

调度者仍在发送前用 commentary 写出双 ID 与 coordinator task ID 供审计，但它不是 UI 回传锚点。ZCode UI 发送与发送后确认成功后，当前派发 turn 的 final answer 必须包含以下独立普通文本块，字段逐字来自账本和当前 task：

```text
ZCODE_CALLBACK_ANCHOR_V1
coordinator_task_id: <coordinator_task_id>
run_id: <run_id>
dispatch_id: <dispatch_id>
status: dispatched
```

这个 top-level final assistant block 才是回传目标证明。commentary、reasoning、tool progress、折叠活动、跨消息拼接或历史中零散出现的 ID 均无效。ZCode worker 只在完成所有项目活动并通过 helper release 后验证该锚点，再发送 `completed`、`blocked` 或 `needs_decision` 四行回报；任一步无法确认都报告 `delivery_status: manual_required`，不得猜测目标、改投其他任务或声称已回传。

## 并行边界

ZCode App 可以在不同项目、不同对话中并行运行多个 worker。后台 worker 的“工作中”不等于另一个 Codex 正在操作 UI；判断 UI 是否可操作以 Hook 为准。任何时候都不得在别人的项目对话中发送，即使提示词写了正确目录。
