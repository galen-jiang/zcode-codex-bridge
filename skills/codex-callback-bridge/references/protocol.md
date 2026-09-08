# Codex callback protocol

## Dispatch envelope

The ZCode task must explicitly invoke `/skill codex-callback-bridge` and contain exactly one complete block:

```text
ZCODE_DISPATCH_ENVELOPE_V1
run_id: <lowercase UUID>
dispatch_id: <lowercase UUID>
ledger_path: <absolute path ending /zcode-runs/<run_id>.json>
tombstone_path: <same directory>/<run_id>.tombstone
receiver_path: <same directory>/<run_id>.<dispatch_id>.receiver
codex_project: <exact visible Codex project name>
codex_task_title: <exact visible Codex task title>
coordinator_task_id: <exact Codex task ID>
stop_at: <RFC 3339 timestamp with offset>
```

All fields are required and single-valued. The three state paths must be absolute, normalized, share one real directory named `zcode-runs`, and match both IDs. Refuse before `claim` if `stop_at` has passed. Do not derive missing values from filenames or old messages.

## Durable receiver lifecycle

Use the installed helper at:

```text
<skills-install-root>/codex-callback-bridge/scripts/receipt.mjs
```

Before any worktree, Git, test, server, or child-process action:

```sh
node <skills-install-root>/codex-callback-bridge/scripts/receipt.mjs claim \
  --ledger '<ledger_path>' \
  --tombstone '<tombstone_path>' \
  --receiver '<receiver_path>' \
  --run-id '<run_id>' \
  --dispatch-id '<dispatch_id>' \
  --coordinator-task-id '<coordinator_task_id>' \
  --stop-at '<stop_at>'
```

Parse the one-line JSON result and retain `receiver_id`. The helper cross-checks the ledger's coordinator, deadline, outstanding dispatch, and receiver path; it never modifies the ledger or tombstone. A receiver directory is an irreversible claim; never delete, repair, or reuse it.

Before every new mutating sequence and every verification command:

```sh
node <skills-install-root>/codex-callback-bridge/scripts/receipt.mjs assert-active \
  --ledger '<ledger_path>' \
  --tombstone '<tombstone_path>' \
  --receiver '<receiver_path>' \
  --run-id '<run_id>' \
  --dispatch-id '<dispatch_id>' \
  --coordinator-task-id '<coordinator_task_id>' \
  --stop-at '<stop_at>' \
  --receiver-id '<receiver_id>'
```

Any nonzero exit is a stop fence. Stop all project work and child processes. `release` remains allowed after a fence so the worker can record its terminal outcome.

After all project activity has stopped, release exactly once:

```sh
node <skills-install-root>/codex-callback-bridge/scripts/receipt.mjs release \
  --ledger '<ledger_path>' \
  --tombstone '<tombstone_path>' \
  --receiver '<receiver_path>' \
  --run-id '<run_id>' \
  --dispatch-id '<dispatch_id>' \
  --coordinator-task-id '<coordinator_task_id>' \
  --stop-at '<stop_at>' \
  --receiver-id '<receiver_id>' \
  --outcome '<completed|blocked|needs_decision>' \
  --reason '<short reason when useful>'
```

Use `completed` only when every dispatched success criterion passed before the deadline, `needs_decision` only when a named coordinator decision is required, and `blocked` for a deadline, fence, repeated failure, exhausted attempt bound, or other blocker.

Do not repeat a failed or successful release. A transition lock or a non-active receipt requires manual reconciliation.

## Codex anchor validation

Open the exact `codex_project` and `codex_task_title`. In the default folded task history, find exactly one top-level final assistant block:

```text
ZCODE_CALLBACK_ANCHOR_V1
coordinator_task_id: <coordinator_task_id>
run_id: <run_id>
dispatch_id: <dispatch_id>
status: dispatched
```

Every value must equal the envelope. Do not accept:

- commentary, reasoning, tool-progress, or collapsed activity;
- IDs spread across different messages;
- a matching title in the wrong project;
- an anchor with a different task ID, run ID, dispatch ID, or status;
- multiple matching anchors.

The Codex final answer may appear just after the ZCode task is sent. If absent, reload or re-open the exact task for up to 30 seconds per observation. Each failed observation is persisted with `scripts/delivery.mjs note-block` (reason `anchor_not_found`) and counts against the bounded location budget; once that budget or the delivery deadline is exhausted, the durable pending record stays behind with its reasons and the worker reports `delivery_status: manual_required` with the record path. A failed anchor search alone never fabricates a target attestation and never authorizes a send.

## Pending delivery recovery

Execution, receipt release, and callback delivery are separate states. The recoverable delivery intent always comes first: after `release` — for `completed`, `blocked`, and `needs_decision` alike — and before any UI locating or sending, persist the pending record with `scripts/delivery.mjs enqueue`; release and enqueue are two separate writes, never one atomic transaction. When a delivery action clearly did not send (for example a focus competition or an unrelated user draft in the target input box) or the send result is uncertain, do not stop at `manual_required` immediately. Persist a pending delivery record with `scripts/delivery.mjs`, let the UI settle, and retry with bounded backoff while the worker session is still active; every retry must re-locate the exact task, re-validate the unique final anchor, and respect the user draft. A result that cannot be proven unsent is verified read-only first, never blindly re-sent. After the retry budget or the explicit delivery deadline is exhausted, retain the durable pending record with its reason and report `delivery_status: manual_required`. The full state machine, lock rules, restart semantics, and capability boundary are specified in [delivery-recovery.md](delivery-recovery.md).

## Callback message

The callback `message_type` must exactly equal the terminal receipt's `outcome`. Send exactly one of these four-line messages.

Completed:

```text
已完成，等待下一步指示
message_type: completed
run_id: <run_id>
dispatch_id: <dispatch_id>
```

Blocked:

```text
任务受阻，等待下一步指示
message_type: blocked
run_id: <run_id>
dispatch_id: <dispatch_id>
```

Decision needed:

```text
需要决策，等待下一步指示
message_type: needs_decision
run_id: <run_id>
dispatch_id: <dispatch_id>
```

Send the callback as ONE real message: internal newlines are composed with Shift+Return (a plain Enter submits), the whole draft is re-read (correct task, empty start, all four lines) before a single submission, and the same sent message is then re-read to confirm all four lines together. A message split across multiple submissions is not a confirmed delivery; do not blind-submit missing lines afterwards and claim success. All confirmation paths require the complete four-line message as the observed evidence. Return to ZCode and report the task outcome, verification evidence, receipt outcome, and either `delivery_status: confirmed` or `delivery_status: manual_required` (with the pending record path and reason when delivery did not complete). Never start another task.
