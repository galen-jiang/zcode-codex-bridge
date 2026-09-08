---
name: codex-callback-bridge
description: Use when a ZCode task contains ZCODE_DISPATCH_ENVELOPE_V1, Codex callback run_id and dispatch_id values, or a requirement to report completed, blocked, or needs_decision back to a Codex coordinator task.
---

# Codex Callback Bridge

Use this skill only for a dispatch carrying the complete `ZCODE_DISPATCH_ENVELOPE_V1` contract. Read [references/protocol.md](references/protocol.md) completely before any project, Git, test, or process action.

## Required workflow

1. Validate every envelope field exactly. Never infer, repair, or reuse an ID, path, task, or deadline. Reject an invalid or expired envelope without touching the worktree.
2. Run the receipt helper's `claim` command before any project action. Capture its `receiver_id`. Failure means no work and manual notification only.
3. Run `assert-active` before each mutating work cycle and before each focused or full verification command. A fence, ledger mismatch, receipt mismatch, or transition lock means stop immediately.
4. Keep one writer in the dispatched worktree. Do only the dispatched task; never start the next task.
5. At completion, blocker, decision need, deadline, or fence: stop project activity and child processes first. Then run `release` exactly once with `completed`, `blocked`, or `needs_decision`. Immediately afterwards — before any UI locating or sending — persist the recoverable delivery intent with `scripts/delivery.mjs enqueue` (or `recover` when backfilling an interrupted run); release and enqueue are two separate file writes, not an atomic transaction, and every terminal outcome needs the record first.
6. Use Computer Use to deliver the matching callback to Codex. Accept only one top-level final assistant block beginning `ZCODE_CALLBACK_ANCHOR_V1` with the exact coordinator task ID, run ID, dispatch ID, and `status: dispatched`. Commentary, reasoning, tool progress, or scattered IDs do not authorize delivery.
7. Before every delivery action, re-locate the exact task and re-validate the anchor; respect any user draft in the input box. Record every observed blocker (anchor not located, window conflict, draft occupied) with `scripts/delivery.mjs note-block` so the reason survives even at zero sends; the durable location budget and the delivery deadline bound these retries — they must not loop forever. If sending clearly fails or the result is uncertain, do not immediately report manual delivery: follow [references/delivery-recovery.md](references/delivery-recovery.md) to persist a pending record with `scripts/delivery.mjs` and retry with bounded backoff. Report `delivery_status: manual_required` only after the delivery budget or deadline is exhausted, including the pending record path and reason; if the session ends with no recovery trigger, state `awaiting recovery` honestly — nothing re-runs in the background.
8. Send the callback as one single four-line message (Shift+Return for internal newlines; a plain Enter submits), re-read the draft before one submission and the sent message after; every confirmation requires the complete four-line message as observed evidence. A confirmed delivery is never sent again.

The receipt is a fail-closed ownership fence, not a task queue. Never edit the ledger or tombstone, delete a receiver, retry a terminal release, or treat callback delivery as permission to continue coding.
Base directory for this skill: <skills-install-root>/codex-callback-bridge
Relative paths in this skill are relative to this base directory.
