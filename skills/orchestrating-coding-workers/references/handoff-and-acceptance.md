# Handoff 与验收

## 派发提示词必须回答

1. **身份与范围**：worker 是谁、是否唯一 writer、只做哪一 Task。
2. **精确现场**：绝对 worktree、分支、完整 HEAD、允许出现的 `git status --short` 集合。任一不符就停止，不自行“修复现场”。
3. **事实来源**：必须完整读取的 brief、spec、report 或失败日志路径；避免复制已经落盘的大段内容。
4. **继承语义**：现有未提交文件是待续作现场还是异常残留；要求先审查再继续，不覆盖、不回退。
5. **授权写集**：可修改文件与明确禁止范围。写集是硬边界；候选 symbol、行号或补丁默认只是线索，worker 可在写集、成功标准和 attempt 预算内完成直接因果修复。只有偏离候选补丁本身会引入具体高风险时，才把它升级为硬限制并写明风险；确需越过写集时停止并报告。
6. **成功标准**：行为、测试、兼容性、性能或持久化契约，每项都可验证。
7. **执行纪律**：需要时严格 RED→GREEN、反向变异、最小实现、禁止破坏性 Git 操作。
8. **验证顺序**：聚焦测试、相关目录、typecheck、build、全量测试及重复次数。
9. **Git 权限**：本轮是否允许 commit，若允许则精确数量与 message；push、merge、amend 分别写明。
10. **完成报告与回传**：固定首行标记、commit、changed files、RED/GREEN、命令与精确计数、剩余限制，以及本轮唯一 `run_id`、`dispatch_id` 和 `message_type`。若 worker 是 Codex，提示词还必须给出派发 task 的准确目标，并要求它在完成、阻塞或需要决策时调用 `send_message_to_thread` 回传一份简洁报告；回传后停止，等待调度者决定下一步。若 worker 是具备 ZCode 自带 Computer Use 的 ZCode App，调度者先在当前派发 turn 的非唤醒式 assistant/commentary 中留下双 ID 与 coordinator task ID 供发送前审计，不能用 `send_message_to_thread` 给本 task 制造额外 turn；发送确认后再在同一 turn 的 top-level final answer 发布稳定 `ZCODE_CALLBACK_ANCHOR_V1`。提示词必须显式加载全局 `/skill codex-callback-bridge`，并按 [ZCode UI 回传桥](zcode-app.md#zcode-ui-回传桥)给出完整动态 envelope；commentary 不构成可见回传锚点。
11. **自治边界**：普通派发是 `max_dispatches=1`、`max_repairs_per_task=1` 的一次性运行。若用户已经批准有限自治租约，提示词还要给出当前 Task 在批准清单中的位置，并声明 worker 只执行当前 Task。每次 attempt 都要写入实现—验证循环数、带时区的绝对 `stop_at` 和全量测试次数上限，以及重复双 ID、重复失败或无新证据时 `blocked` 回报并停止的规则。所有派发都必须按 [autonomous-runs.md](autonomous-runs.md)持久化关联、续派、返修和停止状态；活跃 run 不能被另一个 Codex task 接管。handoff 必须终止旧 run 并停在 checkpoint；新 `run_id` 要重新取得用户批准，且 live worktree 必须与旧 accepted baseline 完全一致，未验收 delta 不得自动继承或重新冻结。

提示词交付的是“调查→实现→聚焦验证”的完整认知单元。首次任务以失败证据、事实来源和可验证结果驱动 worker 自行定位；返修可给出反例与候选原因以免重复诊断，授权边界仍以第 5 项写集和 attempt 预算为准。

## 验收顺序

worker 停止后由调度者执行：

1. 核验 `pwd`、分支、HEAD、`git status`、提交数量和写集，确认没有并发 writer 或越权文件。
2. 阅读完整 diff 与报告；检查原现场是否被丢弃、持久化字节/公共 API/错误分类是否越界。
3. 将 brief 的每个 finding 与测试、实现、报告逐项对账；报告没有代码证据时按未完成处理。
4. 运行新鲜验证，至少覆盖聚焦测试、typecheck、build、`git diff --check` 和 brief 指定全量命令。不要用 worker 的历史输出代替。
5. 对安全、恢复、crash window、兼容性等高风险改动做反例或变异验证。
6. 验收失败时整理可复现的 finding；只有返修额度尚未耗尽才回派同一 worker。验收通过后也必须经过续派闸门，才能进入下一 Task、push 或 merge。
7. 将 verdict、可重建的 accepted baseline、预算消耗和停止原因写入运行账本；普通单 Task 验收后向用户报告并停止。

Codex worker 可以通过 `send_message_to_thread` 主动回传，调度者收到后再验收。ZCode App worker 可以调用 ZCode 自带的 Computer Use，通过 UI 回传桥操作 Codex 并回传；没有该能力或桥接验证失败时，ZCode App、Claude Code CLI 与 ZCode CLI 仍保持人工状态：用户告知 worker 已停止后再验收，不要轮询制造伪心跳。任何回传都不能绕过续派闸门。
