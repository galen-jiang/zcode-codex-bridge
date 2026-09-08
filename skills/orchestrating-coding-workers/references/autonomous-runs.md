# 有限自治运行

## 运行契约

每次派发都属于一个可恢复的运行记录。普通派发是 `max_dispatches=1`、`max_repairs_per_task=1` 的一次性运行；当前 Task 验收后停止。

自治单位是一个有终点的里程碑，不是整个项目。仅当用户批准以下完整契约时建立有限自治租约：

- 唯一 `run_id`、里程碑目标和可验证终止条件。
- 有限且有序的 `approved_tasks`；新发现的工作只进入候选清单。
- `max_dispatches`。用户未指定时取 `min(3, approved_tasks 数量)`。
- `max_repairs_per_task`。用户未指定时为 `1`；一次验收中的 findings 合并成一轮窄返修。
- 每个 attempt 的 worker 侧硬边界：用户未指定时为最多 `2` 个“文件修改批次→一次聚焦验证”循环、最长 `30` 分钟、最多 `1` 次全量测试。一次修改阶段之后执行一次聚焦验证就算一个完整循环；同一 Task、写集和风险边界内，新失败揭示的直接因果修复属于剩余循环，不因它偏离提示词中的候选行或补丁而提前阻塞。派发时把限制换算成明确计数和带 `Z` 或 UTC offset 的 RFC 3339 `stop_at`。
- 明确的写集、Git 权限和必须停下等待用户的风险边界。

开放式“持续做”“不要每次问”只表示用户希望自治；调度者先把它翻译成上述有限契约并取得批准，不能据此创建无限租约。每次租约耗尽后必须停在 checkpoint，由用户续租。

## 可重建基线

首次派发前及每个 Task 验收通过后，冻结可重建的 accepted baseline。干净现场记录完整 HEAD 与空 `git status`。脏现场在账本目录的唯一临时路径中生成 binary-safe snapshot：完整 HEAD 与 status、`git diff --cached --binary`、`git diff --binary`、允许的 untracked 文件，以及 canonical JSON manifest。manifest 按键排序，覆盖 metadata、两个 patch 和每个 untracked 文件的项目相对 POSIX 路径、类型、mode、size 与 SHA-256。

先 flush/fsync snapshot 的全部内容，计算 `manifest_sha256`；再生成包含 manifest 的 tar、flush/fsync 并计算 `archive_sha256`。重新解包校验两种摘要和逐项 manifest 后，才把 tar 原子 rename 到不可变路径并 fsync 父目录，最后由账本 CAS 引用它。每次增量审查前重复完整性校验；缺件、不匹配或不能无损重建时立即停止，不能继续 delta-only review。

## 运行账本

首次派发前创建 `~/.codex/state/zcode-runs/<run_id>.json`。账本在 worktree 外，只由调度者写入，至少记录：

```json
{
  "run_id": "<run-id>",
  "coordinator": { "task_id": "<immutable-codex-task-id>" },
  "revision": 0,
  "milestone": "<goal and terminal predicate>",
  "approved_tasks": ["<task-id>"],
  "task_cursor": 0,
  "current_task": "<task-id>",
  "accepted_baseline": {
    "head": "<full-head>",
    "status": "<git-status-short>",
    "snapshot_path": "<path-or-null>",
    "manifest_sha256": "<digest-or-null>",
    "archive_sha256": "<digest-or-null>"
  },
  "attempt": { "kind": "task|repair", "dispatch_id": "<dispatch-id>", "receiver_receipt_path": "<absolute-path>" },
  "dispatches": { "used": 0, "max": 3 },
  "repairs": { "<task-id>": { "used": 0, "max": 1 } },
  "attempt_limits": { "work_cycles": 2, "minutes": 30, "full_suite_runs": 1, "stop_at": "<rfc3339-with-offset>" },
  "outstanding_dispatch_id": "<dispatch-id>",
  "handled_dispatch_ids": [],
  "finding_fingerprints": [],
  "last_verdict": null,
  "message_type": null,
  "status": "ready|dispatching|dispatched|reviewing|stopped|complete",
  "stop_reason": null
}
```

## 单一协调者与原子迁移

每个 run 终身只绑定一个不可变 Codex coordinator task，活跃 run 不做 owner 移交。任何读取后写入或外部动作前，先确认不存在 `<run_id>.tombstone`，再以原子 `mkdir` 取得 `<run_id>.lock`；取得后再次检查 tombstone。lock 内写入随机 `holder_id`、coordinator task ID 与不可变的 `acquired_at_revision`，并 fsync lock 内容、lock 目录和父目录。已被占用或任一 tombstone 检查命中，就不等待、不抢锁、不动作。

所有状态迁移都在持锁时执行：重新读取账本，核对 coordinator task ID、lock 的 `holder_id`、持锁者内存中随成功 CAS 推进的 expected `revision`、`status` 和 `outstanding_dispatch_id`，再以同目录临时文件写完整新状态并将 `revision` 加一。持久化顺序必须是临时文件 flush/fsync → 原子 rename → 账本父目录 fsync；这三步完成后才允许 UI 或其他外部动作。任一前置值不符视为 CAS 失败：释放 lock、重新读取且不得执行对应动作。外部动作紧前再次确认 tombstone 不存在，并核对 holder、当前 expected revision、status 和 dispatch ID；持锁到动作确认与后续状态落账完成，最后释放 lock 并 fsync 父目录。

lock 不按时间自动失效，也绝不被活跃实例偷取。若残留 lock 的 owner 状态不明，保持原状并 checkpoint。每个 attempt 另用永久的 `<run_id>.<dispatch_id>.receiver` 目录作为 receiver receipt；目录以原子 `mkdir` 只创建一次，内部状态只能是 `active|released|abandoned`，目录永不删除。worker 通过 ZCode 全局 `codex-callback-bridge` skill 的 helper 管理 receipt；所有 `active → released|abandoned` 转换都先以原子 `mkdir` 独占 receipt 内的 `.transition.lock`，完成 receipt 与目录 fsync 后才释放该锁。残留或竞争中的 transition lock 一律 fail closed。`active` 表示 writer 可能存活，不能完成 terminalization、派新 worker或启动新 run；任何状态的 receipt 都阻止同一 dispatch 再次 claim。

公开包能力边界：随包 `coordinator-run-v1.mjs` 没有强制 terminalization 命令，下面描述的是部署方恢复工具必须满足的协议，不是可直接调用的功能。若 writer 失联、receipt 仍 active，或 owner 无法核实，当前安装仅能保留 checkpoint 并请求人工处置；在部署方提供经过审查且获授权的恢复工具前，不执行下面的终止流程，不临时拼 shell 手改回执/锁，也不借新 run 绕过现场。

terminalization 必须按固定顺序执行：先不可逆地终止旧 Codex coordinator；再在唯一临时目录中完整写入并 fsync tombstone metadata，用禁止覆盖既有目标的原子 rename 发布为正式永久 tombstone，并 fsync 父目录。多个 terminalizer 竞争时只有成功发布正式 tombstone 的一个继续，其余停止；旧 lock 暂时保留，正式 tombstone 已足以阻止所有取锁与 receiver 二次校验。

正式 fence 生效后，停止并确认 ZCode writer 与所有后台活动已经结束。receiver receipt 为 `active` 时，只有 terminalizer 能在 writer 已被不可逆终止后取得同一个 `.transition.lock`，重新核对 `receiver_id + status=active`，原子写为 `abandoned` 并 fsync；若锁、身份或状态不符就 checkpoint，不能覆盖 `released`。随后把旧 lock rename 为永久 `.retired-lock` 证据并 fsync 父目录。只有 tombstone 已持久化、writer 已静默且不存在 `active` receipt，才可执行 terminalizer CAS。

tombstone 内持久化唯一 `terminalizer_id`、旧 `holder_id`（若有）、expected revision/status，以及除 `status`、`stop_reason`、`revision` 外账本内容的摘要。tombstone 建立只是“禁止新工作”的 admission fence，不代表旧 writer 已停止；terminalization 完成以 writer 静默、receipt 非 `active` 和 recovery CAS 全部成立为准。

terminalizer CAS 是通用 lock/CAS 的唯一例外：只有 tombstone 中的 `terminalizer_id` 可在 expected revision/status 与保留内容摘要完全匹配时，将 `status` 改为 `stopped`、填写 `stop_reason` 并把 revision 加一；预算、attempt、outstanding 与 baseline 必须逐字节保持。它使用相同的文件与父目录 fsync 顺序，已经处于匹配的 `stopped` 状态时视为幂等成功；任何不匹配都 checkpoint。terminalizer 不能派发、重置成 `ready/reviewing` 或删除 tombstone。

handoff 或新 coordinator 不能继承活跃租约：旧 run 先停在 checkpoint，新 `run_id` 必须重新取得用户批准，不能靠重复 handoff 重置 Task/repair 额度。建新 run 前还必须证明 live worktree 与旧 accepted baseline 完全一致；存在任何未验收 delta 时保持现场并请用户处置，不得丢弃、继承或重新冻结为 accepted baseline。旧 run 永不复活。

## 外部发送与恢复

每次新 Task 或返修都使用新的 `dispatch_id`。改变 ZCode UI 前，先按上述 CAS 与持久化顺序写入 `status=dispatching`、attempt、outstanding ID、`message_type=null` 和 attempt 硬边界，并预先消耗对应的 dispatch 或 repair 额度。随后在当前派发 turn 的一条非唤醒式 assistant/commentary 审计消息中留下同一对完整 `run_id`、`dispatch_id` 和 coordinator task ID；该消息只用于发送前对账，不是 ZCode 可接受的回传锚点。禁止用 `send_message_to_thread` 给本 task 发送会触发额外执行的用户消息。审计字段与账本一致、UI 已准备发送后，先用 CAS 将 `dispatching → dispatched` 并完成父目录 fsync，把它作为唯一发送授权，再立即执行一次 UI 发送；绝不从 `dispatched` 重发。发送与界面确认成功后，当前派发 turn 的 top-level final answer 必须带一个独立的 `ZCODE_CALLBACK_ANCHOR_V1` 普通文本块，逐项包含同一个 coordinator task ID、`run_id`、`dispatch_id` 与 `status: dispatched`。commentary、reasoning、tool progress 或分散字段都不能替代它。只有能证明消息未提交且永久 receiver 不存在时，确定的发送失败才可用 CAS 写为 `stopped`。发送结果不确定时不得发布 final 锚点、不得重发、也不得直接把账本写成 terminal 状态；保持 `dispatched`，保留已消耗额度并进入 checkpoint，由正式 fence/terminalization 流程在 writer 静默且 receipt 非 `active` 后完成停止。

每个 ZCode 提示词的首行都要显式加载 `/skill codex-callback-bridge`，紧接完整 `ZCODE_DISPATCH_ENVELOPE_V1`，给出账本、tombstone、receiver receipt 的绝对路径、Codex 回传目标、coordinator task ID 与 `stop_at`，并原样带入其余 attempt 硬边界。worker 的首批 filesystem/process 操作只能调用该全局 skill 的 receipt helper；握手完成前禁止写 worktree、启动项目命令或执行 Git：

1. 确认当前 ZCode 对话没有更早的同一 `run_id` + `dispatch_id`，tombstone 不存在，账本是 `status=dispatched` 且 outstanding ID 精确匹配。
2. helper 逐字核对账本中的 coordinator task ID 与 `stop_at`，拒绝已过期 attempt；再生成随机 `receiver_id`，以原子 `mkdir` 创建永久 receipt 目录，并用原子文件替换写入 protocol、`run_id`、`dispatch_id`、coordinator task ID、`stop_at`、`receiver_id`、`status=active`，fsync receipt 与父目录；目录已存在就停止。
3. 创建 receipt 后再次读取 tombstone 与账本；任一条件变化就由同一 `receiver_id` 原子写为 `abandoned`、fsync 并停止。只有二次校验通过才能首次修改 worktree。

worker 保持 receipt 为 `active`，贯穿全部文件写入、项目进程、测试、Git 与后台活动；每个新的修改—验证循环和全量测试前通过 helper 再次校验 tombstone、账本状态、outstanding ID 与 receipt 身份。聚焦验证出现新失败时，只要有直接因果证据、仍在同一 Task/写集/风险边界且尚有循环，worker 就继续最小修复；“与预计补丁不同”本身不是阻塞原因。所有这类活动完全停止后，必须通过 helper 取得 transition lock，并以 `receiver_id + status=active` 为前置将 receipt 原子写为 `released` 并 fsync；若锁、身份或前置状态不符就停止回传。receipt 目录继续永久保留，然后才按全局 skill 验证 final 锚点并执行 Computer Use 回传或写最终报告。worker 自行计数：以“命令 + 测试名 + 首个稳定错误类型/项目相对位置”识别同一失败；同一失败连续出现两次、一个循环没有有效 diff 或新证据、达到循环/全量测试上限或到达 `stop_at`，任一发生就停止所有活动并以 `message_type=blocked` 回报。worker 不能自行开始下一 Task、扩展范围、无限“再试一次”，也不能把调度者的返修额度当作本 attempt 内的自助续命。

回报只有在 `run_id` 正确、`dispatch_id` 等于 outstanding 且尚未处理时有效；处理前还要确认该 attempt 的永久 receiver receipt protocol、双 ID、coordinator task ID、`stop_at` 与 receiver 身份正确、状态为 `released`，并且 receipt 的 `outcome` 逐字等于回报的 `message_type`，否则不能把回报解释为对应结果。receipt 仍为 `active` 时 writer 不算静默：停止处理该回报和所有新动作，保持 `dispatched` 并 checkpoint；需要停止 run 时必须走正式 fence/terminalization，且此时不把 dispatch 标为 handled。receipt 已终态但 outcome 与回报不一致时，用一次 CAS 将该 dispatch 记为 handled、清空 outstanding 并写为 `stopped`，记录 mismatch 后 checkpoint，绝不进入验收或续派。收到完全一致的有效回报后，用一次 CAS 原子记录 `message_type`、handled ID 与新状态：

- `completed`：写为 `reviewing`，恢复或开始当前 Task 的独立验收。
- `blocked`、`needs_decision`：清空 outstanding ID，写为 `stopped`，记录原因并进入 checkpoint，不做验收、返修或续派。
- 双 ID 正确但 `message_type` 不属于上述三种：将 ID 记为 handled、清空 outstanding 并写为 `stopped`，不能留在 `dispatched`。
- 已 handled 的重复 ID：忽略且不改变预算；错误 run 或未知 ID 不驱动本 run，若它与唯一未决 attempt 的来源产生冲突而无法对账，则停止运行。

重启或上下文压缩后，先取得 run lock、核对 coordinator task ID、holder 与 revision，再按状态恢复：

- `ready`：只用于首次派发前；重新验证基线、租约与第一 Task 后，必须一次 CAS 进入 `dispatching` 或 `stopped`。
- `dispatching`：尚未授予发送；恢复时直接转为 `stopped`，不能补发。
- `dispatched`：可能已发送，也可能在授权落账后崩溃。只做一次只读对账；证明已发送才继续等待当前 attempt 的主动回报；证明未发送且 receiver 不存在才可转为 `stopped`。其余不确定情形保持现场并进入正式 fence/terminalization，绝不重发或轮询。
- `reviewing`：不需要新回报，校验基线 snapshot 后从新鲜现场恢复验收。
- `stopped`、`complete`：终态，不自动恢复。

状态、预算、revision、outstanding ID、coordinator/lock holder 或现场互相矛盾时立即停止新动作并 checkpoint；只有证明没有活跃 writer，或已完成前述正式 fence/terminalization，才能把账本写为 `stopped`。handoff 不能接管原 run；按前述规则终止旧 run 并创建新 run。

## 验收、返修与续派

只有 `completed` 进入验收。调度者持有 run lock 完成新鲜验收；将每个 finding 规范化为按键排序的 canonical JSON：规则/测试 ID、项目相对 POSIX 路径、稳定 symbol 与首个稳定错误 code/type，并去除行列位置、时间戳、PID、随机地址和临时绝对根目录，再以 SHA-256 计算 fingerprint。

每次验收只允许一次终局 CAS，不留下“已判定但未决定下一动作”的中间态：

- 失败且允许返修：同一 CAS 写入失败 verdict 与 fingerprints，预消耗 repair，换成新的 repair attempt/outstanding ID，清空 `message_type` 并直接 `reviewing → dispatching`。
- 失败且达到 repair 上限、fingerprint 再现、没有有效新 diff 或 attempt 已越过自身硬边界：同一 CAS 清空 outstanding 并 `reviewing → stopped`。
- 通过且里程碑终止条件成立：先生成并验证新 baseline snapshot，再用同一 CAS 写 baseline、通过 verdict、清空 outstanding 并 `reviewing → complete`。
- 通过且可续派：先生成并验证新 baseline snapshot；必须满足不变量 `current_task == approved_tasks[task_cursor]`，且下一 Task 精确为 `approved_tasks[task_cursor + 1]`。只有下一 Task 与全部续派闸门成立、当前 attempt 未越界时，才用同一 CAS 写 baseline、通过 verdict、将 task cursor 加一并同步更新 current task、预消耗 task dispatch、换成新 attempt/outstanding ID、清空 `message_type` 并 `reviewing → dispatching`。
- 通过但不能续派：同一 CAS 写新 baseline 与通过 verdict、清空 outstanding 并 `reviewing → stopped`。

若 `completed` 回报晚于 `stop_at`，或报告证明 worker 超过循环/全量测试边界，仍做一次验收以保留有效成果；除非验收通过且里程碑已经完成，否则必须 `stopped`，不能自动返修或续派。

验收通过后按以下顺序决定：

1. 若里程碑终止条件已经成立，选择 `complete` 分支。
2. 里程碑未完成时，确认当前不变量成立，下一 Task 是 `approved_tasks[task_cursor + 1]`，且 brief、写集、成功标准和验证顺序完整。
3. 确认 `dispatches.used < dispatches.max`，当前 attempt 未越界，并且下一 Task 不需要新的产品、架构、安全、兼容性或权限决策。
4. 全部成立才选择原子续派分支；任一不成立就选择 `stopped` 分支并记录 `stop_reason`。

达到 repair 上限只在当前 Task 尚未通过时停止；已经验收通过的 Task 不因用完自身 repair 额度阻断下一 Task。最终 Task 同时命中里程碑与 dispatch 上限时以 `complete` 为准。

## 必停条件

- 一轮自动返修后仍未通过，或同一 finding 再现、没有可验收的新 diff。
- worker 未静默、来源无法对应、基线不可重建、出现并发 writer 或越权文件。
- 下一 Task 不在批准清单、brief 不完整，或需要扩大写集和外部副作用。
- 涉及新架构选择、公共 API、数据迁移、安全边界、破坏性 Git，或未授权的 commit、push、merge、amend。
- worker/Computer Use 不可用，继续动作所需额度已经耗尽，或继续需要新增付费与权限；已经命中里程碑终止条件的完成态不被预算边界改写。
- 用户暂停或改变目标；里程碑尚未完成且下一次 Task 或返修会超过已批准预算。

停止意味着不再发新提示词、不切换 writer、不轮询。调度者给出 accepted baseline、完成任务、剩余任务、验证证据和停止原因，等待用户决定。

## Token 经济性

- 派发完整认知单元，不派发已经由调度者解出的机械编辑；当前没有活动 writer 且唯一安全局部补丁与验证方法均已确认时，由调度者直接修改并验收，不为它创建新 run。
- worker 已持有 writer 时，把同一写集内的新直接因果修复留在当前 attempt 的剩余循环；候选行和补丁只用于减少重复调查，不缩窄已经批准的结果契约。
- 每轮只审查相对可重建 `accepted_baseline` 的新 diff；无有效 delta 就提前停止。
- 提示词引用落盘 brief 和日志，不重复粘贴已存在的大段规格。
- 每个 Task 运行聚焦验证；全量验证放在里程碑边界，除非 brief 或高风险改动要求更早执行。
- 活跃租约只维护紧凑账本；用户可见的长汇总放在 checkpoint、阻塞或完成时。
- 不轮询 worker，不自动执行候选任务，不用不可验证的 token 估算替代硬性的 Task/repair 上限。
