# Delivery recovery specification

This reference specifies the bounded, recoverable callback delivery layered on top of the existing Computer Use workflow. `scripts/delivery.mjs` is a deterministic state machine: it owns persistence, attempt accounting, locking, and stop conditions. It never drives the UI itself; the worker observes the UI and feeds results back in.

## Failure modes covered

- A transient conflict at send time: the Codex window lost foreground, or the target input box holds an unrelated user draft, and the action reports `action_sent=false`. The message is proven unsent and may be retried after backing off.
- An uncertain send: the action was dispatched but the confirmation re-read failed or timed out. The message may or may not be visible. Re-send is forbidden until a read-only check proves absence.
- A message that is already present: verification finds the full four-line callback and the delivery is confirmed without another send.
- Budget or deadline exhaustion, coordinator handling, run cancellation, or a target that no longer matches: re-delivery stops with a retained reason.

## Separate states

Work execution, the terminal receipt (`released` with `completed|blocked|needs_decision`), and callback delivery are independent. Recovery never redoes business work, never re-claims or re-releases a receipt, never mutates a terminal receipt or outcome, and never opens a new writer in a worktree. A pending entry binds exactly one released receipt plus the full envelope identity (run, dispatch, coordinator, receiver) and derives the four-line message from that identity, so the target and message cannot drift during recovery. Other runs' callbacks are never queued, replayed, or re-sent.

## Records

- Production pending records live in `~/.zcode/state/codex-callback-deliveries/<run_id>.<dispatch_id>.pending.json`. Tests always use isolated temp directories.
- Each record stores: envelope identity, released-receipt identity (`receiver_id`, outcome), message type, policy (max attempts, backoff base/cap, target-check max age), the explicit `delivery_deadline`, current state, `attempts`, `attempts_started`, `next_eligible_at`, `eligible_since_ms`, last error, bounded history, and a generation counter.
- The work deadline (`stop_at` in the envelope, enforced by the receipt helper) and the delivery deadline are distinct clocks. The delivery deadline is the only bound on delivery permission; an expired delivery permission never revives work authorization.
- Every read and every mutating command validates the record against the full schema: exact protocol, known state, canonical path bindings (symlinks rejected), UUID/identity fields, non-negative bounded integer counters (`attempts`, `attempts_started`, `generation`), consistent instants (`delivery_deadline_ms` must equal `Date.parse(delivery_deadline)`, same for `next_eligible_*`), sane policy numbers, and a cross-check of the bound released receipt on disk (identity, outcome, and message type). Tampered, drifted, or corrupt records fail closed at every entry point and are never repaired silently.

## State machine

```
queued ──begin──▶ in_attempt ──unsent──▶ waiting_backoff ──begin──▶ in_attempt ...
                     │  │                                     
                     │  └─sent_unconfirmed──▶ needs_verification
                     │                            │            │
                     │                     verify found=true   verify found=false
                     │                            ▼            ▼
                     ├─confirmed◀─────────────────┘      waiting_backoff (budget left)
                     ▼                                          │
                 confirmed (terminal)                budget/deadline exhausted
                                                            ▼
                     any non-terminal ──record-stop──▶ stopped (terminal)
                     budget exhausted ────────────────▶ parked (terminal)
```

- `waiting_backoff`: a clearly-unsent failure schedules `next_eligible_at = now + min(base·2^(attempts-1), cap)`. `begin-attempt` before that instant is refused.
- `needs_verification`: entered on `sent_unconfirmed`, on `reclaim-stale-lock` (the crashed owner may have already sent), and by crash self-heal (a record left `in_attempt` with no lock). Only `verify` may leave it: `found=true` confirms; `found=false` (proven by reading the full top-level final block) returns to bounded backoff and charges the pending attempt against the budget; budget exhaustion parks it. `begin-attempt` is refused in this state.
- `parked`: durable, no automatic retry, reason retained (`attempt_budget_exhausted`, unverified send). Recommended action: `manual_review`.
- `stopped`: terminal with reason (`delivery_deadline_expired`, `run_cancelled`, `coordinator_handled`, `target_mismatch`). No further sends; the reason is preserved in the record.
- `confirmed`: terminal. `begin-attempt` is refused forever after.

## Authority revalidation (machine-checked)

Anchor presence in the UI history is never sufficient authorization by itself. Before `enqueue`, every `begin-attempt`, and every `verify`, the script re-reads the authoritative state from disk and refuses to authorize a send when: the run tombstone exists (cancelled); the ledger's status is no longer `dispatched`, its `outstanding_dispatch_id` has advanced past this dispatch, or `handled_dispatch_ids` contains this dispatch (handled/complete); the ledger attempt or coordinator no longer matches; or the bound receipt file is missing, no longer a `released` terminal receipt, or drifted in any identity field. A worker-declared `record-stop` cannot substitute for this gate. If authority dies while an attempt is open, `record-result` records `stopped` (reason `run_cancelled`, `coordinator_handled`, or `authority_lost`) instead of recording normal flow.

## Retry conditions (all required)

1. The worker re-located the exact `codex_project`/`codex_task_title` and re-validated the single top-level final anchor block, and passes a fresh `--target-verified-at` attestation: it must be at most 30 seconds old and must postdate the moment the current backoff or verification state began. An attestation made before waiting is stale.
2. `now` is at or after `next_eligible_at` and before `delivery_deadline`.
3. The state is `queued` or `waiting_backoff`, attempts are below `max_attempts`, and the attempt lock can be acquired.
4. A user draft in the target input box is observed and left untouched; the recovery vocabulary contains no action that clears input, closes sessions, steals locks, bypasses permissions, or drives the UI through any channel other than ZCode Computer Use. Window or focus changes never authorize typing into a different task.
5. Confirming presence (`verify --found true`) requires `--observed-message` to equal the four lines derived from THIS record's identity, so a sibling dispatch's callback on the same coordinator task cannot satisfy verification.
6. If the target no longer matches, or the coordinator handled the dispatch, the run was cancelled, or the deadline passed: `record-stop` with the matching reason instead of a retry.

## One message, submitted once

The canonical callback is four lines in ONE real message. Composer behavior to rely on: a plain Enter submits the draft, so internal newlines must be entered with Shift+Return (or equivalent), never assumed to be inert. Required sequence: start from an empty composer in the exact target task; construct the whole four-line block; re-read the draft (empty start confirmed, all four lines present in order, correct task); submit exactly once; then re-read the task and require the complete four lines within that single sent message. A partial submission (for example only the first line) is not a delivery: never blind-submit the remaining lines as separate new messages and claim canonical success. Every confirmation entry point (`record-result --result confirmed` and `verify --found true`) requires `--observed-message` to equal the complete four-line message exactly; a split or partial observation must stay unconfirmed (retry per the uncertainty rules or park with a reason).

## Uncertainty is not absence

`action_sent=false` from a verified action is "clearly unsent" and may back off and retry. Any other failure (tool timeout, lost confirmation read, crashed worker mid-attempt) is "uncertain": the record enters `needs_verification`, and the next step is a read-only re-read of the full final block. Nothing is re-sent while the record is in `needs_verification`. The chain does not provide exactly-once; it provides at-most-once-send-per-attempt with explicit evidence for every attempt.

## Locking and concurrent recoverers

- An attempt is guarded by an `O_EXCL` lock file (`<run_id>.<dispatch_id>.attempt.lock`) next to the pending record, containing the owner token, owner pid, acquisition time, and a lease stamp. Owner tokens must be unique per recoverer session, and every owner operation must present the same token and pid it began under; a same-token request from another process is refused.
- A second recoverer whose `begin-attempt` finds a live lock is refused (`attempt lock held`) and cannot record results. Exactly one sender exists per attempt.
- A lock whose owner pid is provably dead is never stolen by waiting. It is cleared only by `reclaim-stale-lock` naming the exact `--prior-owner` and passing liveness proof (ESRCH); the reclaim is audited in history, attempts and deadlines are preserved, and the record enters `needs_verification`, because a crashed owner may have already sent.
- The lease stamp is recorded and reported but not enforced as a steal timer; there is deliberately no wait-long-enough-and-take path. A lock that can never be resolved (for example a pid reused by an unrelated process) wedges that record until the delivery deadline stops it — an acknowledged availability cost accepted in exchange for never stealing an unknown lock.
- Every mutating command runs inside one common state mutex (a `.state.lock` file next to the pending record, bound to the writer's pid): enqueue, begin, record-result, verify, release-attempt, reclaim, and record-stop all serialize on it, so cancellation races cannot be lost updates and a stop cannot be clobbered by an in-flight writer.
- Ownership is published atomically: the writer first writes its complete identity (pid, timestamp) to a unique temp file and then hard-links that file to the mutex path. `link` fails atomically with `EEXIST` when the mutex exists, so a holder suspended at any point can never present an empty or torn lock, and competitors never face an unknown lock created by this protocol.
- Unknown is not dead, and dead is not removable. A mutex that already exists is never removed automatically — not on a timer, and not even when its recorded pid is provably dead (ESRCH), because a dead-reclaimer can delete a live successor's lock and let two writers into the critical section (lost update). Competitors wait briefly for a live holder's normal release; if the mutex is still present they fail closed with a clear error and the record is left for manual reconciliation. A human must confirm every participant is silent before removing a stuck mutex; agents never delete it themselves. The availability cost of a crashed holder (mutations stay refused until a human reconciles) is an accepted trade-off.
- The state mutex is distinct from the attempt lock: the attempt lock's reclaim-stale-lock path remains available for a genuinely interrupted delivery attempt, while the state mutex has no automatic reclaim at all.
- Release is ownership-bound: the holder unlinks the mutex path only while it still refers to the exact inode it published. If the path changed hands, the new owner's lock survives untouched, and the old holder removes only its own temp file. Generation checks remain as defense in depth. Every transition saves the new state before releasing the attempt lock, so a crash in between leaves an orphan lock (discarded by the next `begin-attempt` once its pid is provably dead) but never loses the recorded outcome.

## Restart and recovery triggers

All counters, deadlines, targets, errors, and confirmation results live on disk, so a restarted process resumes without resetting the budget or extending deadlines. A crash between the send action and its `record-result` lands in `needs_verification` (via `reclaim-stale-lock` or crash self-heal), so the next step is always a read-only verification, never a blind re-send. Honest trigger model:

- While the worker session that released the receipt is still active, it performs the backoff loop itself (sleep to `next_eligible_at`, re-verify, retry).
- There is no daemon, scheduler, or self-wakeup. If a session ends with delivery unconfirmed, nothing fires automatically afterwards; the durable pending record is the resumption entry point for the next authorized session (the next skill invocation or coordinator instruction), which reads `status` and continues inside the remaining budget and delivery deadline or reports `manual_required` with the record path. This capability boundary is stated, never papered over.

## Commands

All commands print one JSON line on success and fail with a message on stderr.

| Command | Purpose |
| --- | --- |
| `enqueue` | Bind a pending record to a released receipt; refuse forged, unfinished, mismatched, or already-bound identities and past deadlines. Idempotent for identical identities. Run immediately after `release` and before any UI action, for every terminal outcome: release and enqueue are two file writes, not one atomic transaction. |
| `recover` | Authorized backfill for the release→enqueue crash window: when a worker died after `release` but before any record existed, the next explicitly authorized session rebuilds exactly one record from the trusted dispatch information and the terminal receipt. It re-checks tombstone, ledger outstanding dispatch, coordinator, and receipt identity; it never re-releases, reruns work, extends deadlines, or duplicates sends. A missing `--delivery-deadline` is refused with the reason durably persisted as `<state-dir>/<run>.<dispatch>.recovery-blocked.json` (no sendable record and no permission is created) — old envelopes are handled conservatively, never given an invented deadline or expanded permission, and an existing record can never be re-deadlined or re-identified by new parameters. |
| `note-block` | Persist one observed zero-send blocker (anchor not located, window conflicts, draft occupation, ...) with its evidence, keeping attempts=0 self-explanatory. The location budget is a durable per-record counter (`location_blocks_total`) that survives history trimming, reason rotation, and restarts; past 8 observations (or any observation after the delivery deadline) the record stops durably (`location_budget_exhausted` / `delivery_deadline_expired`) instead of looping forever. Recording is diagnostic only: it never fabricates a target-verified attestation, never authorizes a send, and on records that are `in_attempt`, `needs_verification`, terminal, or holding an attempt lock it is an accepted no-op that leaves send state, owner, and locks exactly as they were. |
| `status` | Read-only view: state, attempts, next eligible time, remaining budget, last error, lock holder, derived message text, recommended action. |
| `begin-attempt` | Acquire the attempt lock under the retry conditions; refuses stale target attestations, elapsed deadlines, unelapsed backoff, `needs_verification`, and terminal states. A past deadline transitions the record to `stopped`. |
| `record-result` | Owner-only. `unsent` (optionally `--draft-present true`) schedules backoff or parks on budget exhaustion; `sent_unconfirmed` enters `needs_verification`; `confirmed` confirms and releases the lock. |
| `verify` | Owner-only read of the uncertain-send state: `found=true` confirms without re-sending; `found=false` proves absence and returns to backoff. |
| `release-attempt` | Owner abandons an attempt before any UI action; no send-budget consumption, backoff still applies. |
| `reclaim-stale-lock` | Explicit takeover of a dead owner's lock; refuses live pids and wrong prior-owner names. |
| `record-stop` | Stop re-delivery from any non-terminal state with a retained reason. |
| `render-message` | Emit the exact canonical four-line callback derived from the bound identity. |

## Command examples and record compatibility

```sh
# Result-first intent, immediately after release (all outcomes):
node scripts/delivery.mjs enqueue \
  --state-dir ~/.zcode/state/codex-callback-deliveries \
  --run-id <run-uuid> --dispatch-id <dispatch-uuid> \
  --coordinator-task-id <coordinator-uuid> \
  --codex-project Tasks --codex-task-title "<exact title>" \
  --ledger-path <state-dir>/<run>.json \
  --tombstone-path <state-dir>/<run>.tombstone \
  --receiver-path <state-dir>/<run>.<dispatch>.receiver \
  --receipt-dir <state-dir>/<run>.<dispatch>.receiver \
  --message-type completed|blocked|needs_decision \
  --work-stop-at <RFC3339> --delivery-deadline <RFC3339>

# Authorized backfill after a crash between release and enqueue (next session):
node scripts/delivery.mjs recover   # same parameters as enqueue

# Persist one zero-send observation (bounded, durable):
node scripts/delivery.mjs note-block --state <record.pending.json> \
  --reason anchor_not_found --evidence "what was observed and when"
```

Record compatibility: records created by the current version carry `record_version: 2` and `location_blocks_total: 0`. On versioned records the counter is schema-validated everywhere (non-negative integer, bounded by 1000000); a missing, malformed, or over-bounds value is tampering and every command refuses with the on-disk bytes preserved. Records that predate the field carry no version marker; their location history cannot be proven complete, so the first `note-block` observation stops them at the explainable `legacy_location_budget_unknown` checkpoint — no remaining budget is inferred and none is invented. Recovery is triggered only by an explicitly authorized session (worker or coordinator instruction); there is no background trigger, and attempts, deadlines, and budgets are never reset by upgrade or restart.

## Scenario → entry → result

| Scenario | Entry | Result |
| --- | --- | --- |
| Any terminal outcome, worker still alive | `receipt.mjs release` then `delivery.mjs enqueue` before any UI action | queued record; delivery proceeds under the existing attempt/verify/backoff loop |
| Worker crashed between release and enqueue | `delivery.mjs recover` with an explicitly authorized deadline in the next authorized session | one backfilled record or a durable `recovery-blocked.json` reason; no re-release, no rerun, no deadline extension |
| Anchor or window blocked, zero sends so far | `delivery.mjs note-block` | durable observation; after 8 observations or past the deadline the record stops |
| Send result uncertain | `record-result sent_unconfirmed` then read-only `verify` | confirmed only with the complete four-line message; never re-sent on doubt |
| Wrong identity, active receipt, handled/cancelled run, expired deadline | `recover`/`enqueue` | refused; nothing created or resumed |
| Session ends with delivery unconfirmed | durable pending record | `awaiting recovery`: nothing runs in the background; the next authorized session resumes it |

## Boundary statements

- The accepted reconciliation entry (`scripts/reconcile.mjs`) only moves a released `completed` receipt into `reviewing` and returns the retained holder for the existing verdict commands; it never marks work accepted, never re-dispatches, and never extends budgets. `blocked`/`needs_decision` reach the stopped checkpoint through the same verification.
- Callback delivery is at-most-once per attempt with explicit evidence; nothing here guarantees exactly-once message delivery, and no daemon, scheduler, or self-wakeup exists to resume delivery after the worker session ends.
