---
name: orchestrating-coding-workers
description: Use when 需要在 ZCode App、Claude Code CLI、ZCode CLI 或 Codex 之间选择执行智能体，派发分析、规划、诊断、编码、测试或审阅任务，处理 ZCode UI 并发、上下文污染、锁屏降级、额度切换、有限自治推进，或独立验收 worker 结果。
---

# 调度编码 Worker

## 定位

调度者负责目标、风险、权限、架构裁决与最终验收；worker 默认承担可自包含的完整认知单元，包括规格/代码调查、计划细化、诊断、编码、聚焦验证、首轮审阅与证据整理。调度者只调查到足以冻结目标、写集、风险和验收标准，不先解出补丁再把机械编辑派给 worker。每个 worktree 同一时刻只能有一个 writer，worker 运行期间调度者只读观察。

## 派发单位

先按用户批准的交付目标归并计划，再填写 `approved_tasks`。当计划各项服务于同一个需求目标、写集与风险边界一致，且没有独立批准的验收门禁时，`approved_tasks` **只登记一个工作包 ID**，首次派发范围是整个需求与全部实现计划。原计划即使命名为 Task 1、Task 2，也只是包内步骤，编号不是拆包依据。

例如“文件导出”包含序列化、下载入口、测试与文档三个编号 Task：登记 `approved_tasks=["FileExport"]`，一次交付全部三项，不先单派序列化。只有不同的用户交付目标或明确的风险/权限门禁才分包，并在 brief 写明理由；无边界的整个项目不能包装成一个 Task。

内部步骤由同一 writer 在有限 attempt 内连续实现、验证和自修；每次 attempt 只在整包完成、受阻或需决策时回报终态。需求、计划与验收清单随包交付，预算按整包估算。

## 执行流程

1. 读取项目指令、任务 brief、分支、HEAD、`git status --short` 和现有 diff，冻结派发基线。未提交改动默认是必须继承的现场。
2. 按 [worker-routing.md](references/worker-routing.md) 选择 worker 与模型。临时 UI 操作冲突先等待；锁屏或 App 不可用才降级。
3. 明确唯一 writer。旧 worker 未停止前不得派新 worker写同一 worktree，也不得在本会话修改、格式化或生成文件。
4. 按 [handoff-and-acceptance.md](references/handoff-and-acceptance.md) 编写自包含提示词，写清精确基线、完整需求来源、实现计划、整包验收清单、授权写集、成功标准、验证顺序、按整包计划估算的有限预算与例外检查点、提交与推送权限；候选原因、行号或补丁默认是调查线索，不是逐 token 白名单。
5. 使用 ZCode App 时，必须先读 [zcode-app.md](references/zcode-app.md)，按其中的精确文本输入与剪贴板回退流程准备、复读后再发送。工作目录写在提示词里不能替代项目与对话归属核验。
6. 发送后释放 UI 操作权。ZCode worker 仍在运行不等于 ZCode UI 被某个 Codex 会话占用；不同项目的独立对话可以并行运行。
7. 派发 Codex worker 时，提示词必须要求它在完成、阻塞或需要决策时通过 `send_message_to_thread` 回传给派发它的 Codex task；回传后由调度者验收并决定是否继续下一工作包。ZCode App worker 若确认 ZCode 自带的 Computer Use 与全局 `codex-callback-bridge` skill 均可用，则提示词必须显式加载该 skill，并按 [ZCode UI 回传桥](references/zcode-app.md#zcode-ui-回传桥)定位并回传到 Codex；否则与 Claude Code CLI、ZCode CLI 一样以人工告知为兜底，不得宣称已自动唤醒。
8. 回传只进入验收态。调度者按工作包做一次完整验收，覆盖需求逐项对账、相对 accepted baseline 的全部新增 diff 与关键风险，findings 合并为一轮窄返修，不按内部步骤重复验收。验收所需的 diff 清单、日志提炼、候选缺陷和首轮静态审阅可交给干净的只读 worker；调度者必须亲自核对基线与写集、裁决关键不变量、按风险重跑验证并作出接受/返修结论。失败时在授权返修额度内优先把具体反例交回同一 worker。用户要求项目自动推进时，必须先读 [autonomous-runs.md](references/autonomous-runs.md) 并使用有限自治租约；没有有效租约就验收当前 Task 后停止。

## 硬约束

- Hook 是 ZCode UI 互斥的执行来源；Skill 不替代或绕过 Hook。
- worker 的“完成”声明只是待验收证据，不能直接进入下一工作包。
- 完成回报只把调度者从等待态切到验收态，不是续派授权；只有当前未处理的 `dispatch_id` 且 `message_type=completed` 可以触发一次验收，阻塞与待决策回报直接进入 checkpoint。
- 回传目标必须是实际派发任务的 Codex task；worker 只报告本 Task 的结果，不能自行开始下一工作包。
- 续派与返修必须受有限自治租约约束；开放式“继续做”不能产生无限 Task、无限返修或自动扩大权限。
- 同一 run 终身绑定一个持锁的 Codex coordinator task，不能由 handoff 接管或借新 `run_id` 自动重置租约；所有状态迁移使用 revision/CAS，单个 worker attempt 也必须有循环数与绝对停止时间，不能把“有限派发”变成单次无限执行。
- ZCode 的 UI 回传桥只在派发时明确提供完整 envelope、ZCode 全局 `codex-callback-bridge` skill 可加载、且 ZCode worker 能用自带的 Computer Use 实际操作 Codex 桌面界面时启用；无法核验稳定 final 锚点或发送结果即回退人工通知。
- 不猜 CLI 参数、模型名或登录状态；先查询本机 `--help`、当前配置或可用模型。
- 不默认 commit、push、merge。严格执行本轮 brief 的明确授权。
