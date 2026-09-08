# 安装指南

`scripts/setup.mjs` 是本包唯一的安装入口，只使用 Node 标准库：不下载依赖、不注册包、不用 curl 管道执行、不请求 sudo、不自动安装系统依赖。一条命令完成 预览→确认→安装→自检。

## 前提

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| macOS | Computer Use 回传路径 | 本包未在其他平台验证 |
| Node.js ≥ 22 | 安装器、协调端、回传桥脚本 | doctor 判定失败；自行安装后重试（本工具不代装） |
| Python 3 | UI guard 及其测试 | doctor 判定失败；Hook 无法运行 |
| ZCode / Codex 桌面版已登录 | 两端宿主 | 先完成登录 |

## 安装目标（由 HOME 与 CODEX_HOME 决定）

| # | 内容 | 默认目标 |
| --- | --- | --- |
| 1 | 回传桥技能（ZCode worker 加载） | `~/.zcode/skills/codex-callback-bridge/` |
| 2 | 编排技能（Codex 调度端加载） | `~/.agents/skills/orchestrating-coding-workers/` |
| 3 | 协调端入口（固定绝对路径调用） | `$CODEX_HOME/tools/coordinator-run-v1.mjs` |
| 4 | UI guard Hook 脚本 | `$CODEX_HOME/hooks/zcode_ui_guard.py` |
| 5 | Hook 配置（用户级，与 config.toml 并列） | `$CODEX_HOME/hooks.json` |
| 6 | 安装清单与持久备份 | `$CODEX_HOME/state/zcode-bridge-install.json`、`$CODEX_HOME/state/zcode-bridge-install-backup-<时间戳>/` |

`CODEX_HOME` 未设置时默认 `~/.codex`。Hook 配置写在用户级 `hooks.json`，不是插件内部的 `hooks/hooks.json`。两端技能角色不同，必须分别落到对应宿主可发现的目录；复制 skill 本身不会自动启用 Hook——Hook 只有写进宿主 Hook 配置才生效。安装清单只描述安装写集；运行账本/receipt/锁不属于安装写集，也永远不会被安装器回滚。

## 一条命令安装

```sh
node scripts/setup.mjs
```

流程：打印精确预览 → 你输入 `yes` 确认 → 安装 → 自动运行 `--doctor` 自检。非交互环境用 `node scripts/setup.mjs --yes` 显式授权；`--preview` 随时可以只读预览。任何未交互、取消、或只运行预览的情况都不会写入。

## 安全边界（统一检查）

- 所有写入路径（含安装清单与备份目录）必须在 HOME / CODEX_HOME 真实锚点之下，从锚点到目标的每一级存在符号链接即拒绝；不提供任意自定义路径选项——删去无法保证安全的灵活性比留着它更好。
- 目标之间不得重叠，任何目标不得位于运行账本目录 `zcode-runs` 内。
- 确认后写入前会重新核验计划：目标在确认窗口内出现/变化时，过期计划作废、不写入并重新提示，绝不覆盖你在确认前后创建的文件。
- 已存在但不属于本包（清单无记录）、内容与清单不符（你可能改过）、Hook 配置损坏或结构无法识别、本包条目被修改：一律拒绝并给出原因。
- Hook 合并只追加本包 5 条事件（命令为 `python3 '<绝对路径>'`，路径已做 POSIX 引用转义，含空格/引号/`$` 也可执行）；你已有的条目与顺序原样保留；重复运行不重复追加。

## 幂等、备份与中途失败

- 重复运行时，内容未变化的目标直接跳过，不产生写入。
- 任何被替换/修改的文件（含 `hooks.json`）先持久备份到备份目录，安装清单发布属于同一事务。
- 写入保留原文件 mode（新建 Hook 配置为 0600）；回滚从持久备份恢复并还原 mode。
- 写入中途失败立即回滚：回滚前逐项核验现场仍属于本次写入——若发现并发修改（例如你在安装期间又改了 `hooks.json`），该项保留现场并如实报告需人工核对，绝不覆盖、绝不误报“已恢复”，备份目录保留供人工恢复。

## 对账绑定与模型

`reconcile-receipt` / `review-holder` 需要 `ZCODE_CALLBACK_BRIDGE_RECONCILE` 指向已安装回传桥的 `scripts/reconcile.mjs` 绝对路径。推荐按命令内联（不要求改 shell rc）：

```sh
ZCODE_CALLBACK_BRIDGE_RECONCILE='<安装打印的绝对路径>' node '<协调入口绝对路径>' reconcile-receipt '<json 配置>'
```

协调脚本只校验该变量非空，不自动验证路径来源；doctor 会检查其设置状态（设置为缺失路径时判定失败）。派发配置中的 `zcodeModel` 由你在派发时显式选择；本包不预设模型，也不会把任何机器上的偏好写进发行包。

## 首次 Hook 信任

宿主首次触发本包 Hook 时会请求你审查并信任（官方 Hook 机制的 trust 审批）；请在客户端中人工批准。本安装器不修改、不绕过任何信任记录。

## 卸载 / 回滚

- 先停止相关 writer、后台活动和调度，确认 receipt 不再 active，再删除安装清单里记录的目录/文件（清单路径见上表）；
- 从用户级 `hooks.json` 中移除命令含本包 guard 路径且结构与本包条目一致的那几条（只删自己加的部分）；
- 回滚约束：运行账本状态目录不能整目录覆盖还原——永久 receiver 回执等历史必须保留，已 `stopped` 的 run 处于防重放终态，不得回退。只恢复你明确备份且理解其语义的文件。
