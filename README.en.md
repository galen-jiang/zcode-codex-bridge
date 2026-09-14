# Token Leverage

> This is the English version of the [Chinese README](README.md), which remains the default front page. The detailed installation and troubleshooting guides are available in Chinese only.

**Let Codex handle planning and review; let ZCode do the hands-on execution.**

zcode-codex-bridge is a task-collaboration tool that connects Codex with the ZCode desktop app. It supports task dispatch, result callbacks, and status reconciliation, reducing the manual forwarding of tasks and results between the two applications.

During periods when ZCode offers free quota, you can hand execution work such as coding and testing to ZCode and reserve more of your Codex quota for problem analysis, task planning, and result review. Which model to use, which files may be modified, and when a task stops are all determined before dispatch.

[Quick start](#quick-start) · [Your first task](#your-first-task) · [Work-package dispatch](#work-package-dispatch) · [Usage limits](#usage-limits) · [Development and testing](#development-and-testing)

## Key features

- **Task dispatch**: define the goal, working directory, and allowed modifications in Codex, then hand the task to ZCode.
- **Result callbacks**: when ZCode finishes, results are returned to the original Codex task for continued review and acceptance.
- **Status reconciliation**: task records and claim receipts are kept, so progress can be checked after an interrupted callback instead of blindly re-dispatching.
- **Setup guidance**: the installer provides a preview, confirmation, and a self-check; detailed configuration and troubleshooting live in separate documents (Chinese).

> The availability and conditions of free quota follow ZCode's actual rules and your account eligibility. This project does not provide free quota, bypass platform limits, or promise any specific savings.

## Quick start

Currently verified on macOS only. Before starting, install and sign in to the Codex and ZCode desktop apps, and have Node.js 22+ and Python 3 ready. The scripts use only the standard library; they do not download dependencies automatically or request `sudo`.

```sh
git clone https://github.com/galen-jiang/zcode-codex-bridge.git
cd zcode-codex-bridge
node scripts/setup.mjs
```

The installer first lists the paths it will modify. Review them and type `yes` to start the installation and the self-check; cancelling writes nothing. Installer prompts and output are in Chinese.

To only inspect the installation plan, run `node scripts/setup.mjs --preview`. In non-interactive environments such as scripts, install with `node scripts/setup.mjs --yes` to confirm explicitly.

After installation you still need to review and trust the Hook in the client and confirm the required macOS permissions. A passing self-check does not mean desktop callbacks already work; we recommend completing the read-only task below.

## Your first task

Replace the project path and the model name with your own choices, then send this message to Codex:

```text
Please hand the following read-only task to ZCode:
Workspace: <your project path>
Model: <the model you choose>
Read README.md and summarize the installation steps in at most 20 lines; do not modify any files.
Send the result back to this Codex task for your review when done.
```

Codex prepares and dispatches the task accordingly. After ZCode returns, Codex checks whether the result meets the requirements; receiving the completed message does not mean acceptance has passed. The first attempt only reads files, which makes it easy to confirm that the cooperation between the two apps works.

The model is your choice and is set as `zcodeModel` in the dispatch configuration; this package does not preset a model. Installing the tool also does not authorize all future tasks: the allowed scope and the stop conditions must be made explicit each time.

For installation locations, Hook configuration, or reconciliation commands, read the [Installation Guide (Chinese)](docs/installation.md). If the self-check reports errors, a callback does not arrive, or a task's status is unclear, consult the [Troubleshooting Guide (Chinese)](docs/troubleshooting.md) before re-dispatching.

## Work-package dispatch

Once the read-only task confirms that collaboration works, dispatch a well-scoped feature as one complete work package: provide the requirements document, implementation plan, acceptance checklist, allowed files, and execution budget together. A plan with several numbered Tasks does not require a separate dispatch for each one. ZCode implements, tests, and repairs within that scope, then submits a consolidated report. Codex reviews all changes and checks coverage of the requirements.

Ordinary implementation choices stay with ZCode. Requirement conflicts, unapproved architecture or interface decisions, migrations or destructive operations, security or permission changes, repeated failures, and insufficient budget still require it to stop and report. This reduces intermediate forwarding and repeated acceptance reviews, not necessary testing or risk checks.

Replace the paths and contents with your own choices and send this to Codex:

```text
Please hand the following work package to ZCode in one dispatch:
Workspace: <your project path>
Branch and baseline: <branch name> at <full commit hash>
Requirements document: <path to the complete requirements and acceptance checklist>
Implementation plan: <path to the complete implementation plan>
Read both documents in full and complete the numbered Tasks for this feature as internal steps.
Write set: <files that may be modified>
Verification: <focused tests and final regression requirements>
Budget: <at most N implement-verify cycles, M minutes, and a full-suite run limit for the whole package>
Report back once for the whole package when done, for a single acceptance review.
```

Estimate the budget for the whole package; N and M are placeholders. Codex records the counts and an absolute deadline before dispatch. Existing tasks retain their original scope and budget. See the [orchestration skill](skills/orchestrating-coding-workers/SKILL.md) and [callback skill](skills/codex-callback-bridge/SKILL.md) for the detailed rules.

## Usage limits

- **Requires a desktop environment.** Automatic callbacks need ZCode's built-in Computer Use, plus macOS Accessibility and Automation permissions. You grant these manually; the installer does not confirm them on your behalf. CLI-based execution does not include desktop callbacks by default. Other platforms are unverified.
- **Callbacks can be interrupted.** Retries are bounded in count and time; when it cannot be confirmed whether a message was sent, records are checked first instead of blindly resending. This project does not guarantee exactly-once delivery, nor reliable unattended delivery.
- **No background self-wakeup.** After a session ends, tasks are not resumed in the background; a new session must be explicitly authorized to handle them.
- **Lost tasks are not forcibly taken over.** The public coordinator script has no command to force-terminate a running task. While a claim receipt is still `active`, preserve the current state and follow the troubleshooting guidance; do not hand-edit the ledger or delete locks to reset state.
- **UI mutual exclusion is limited in scope.** The UI guard only constrains supported tool calls; it does not cover every tool or API and is not an isolation mechanism against malicious local processes.
- **Failed installations may need manual recovery.** When file ownership cannot be confirmed, the installer leaves existing files and any usable backups intact and asks for manual review; not every failure can be rolled back automatically.

This project is provided "as is", without a promise of official support. For details on permissions, recovery, and uninstalling, see the [Installation Guide (Chinese)](docs/installation.md) and the [Troubleshooting Guide (Chinese)](docs/troubleshooting.md).

## Development and testing

Run the following commands from the repository root. The installer and state tests use isolated temporary directories and never touch the real run ledger.

```sh
# Callback bridge
CANDIDATE_BRIDGE="$PWD/skills/codex-callback-bridge" \
COORDINATOR_CANDIDATE="$PWD/scripts/coordinator-run-v1.mjs" \
node --test skills/codex-callback-bridge/tests/*.test.mjs

# UI guard
PYTHONPATH="$PWD/scripts" python3 -B -m unittest discover -s tests/guard -p 'test_*.py' -q

# Installer, path, and scanner tests
COORDINATOR_CANDIDATE="$PWD/scripts/coordinator-run-v1.mjs" node --test tests/*.test.mjs

# Privacy scan (should print PRIVACY_SCAN_CLEAN)
node scripts/privacy-scan.mjs .
```

### Status and privacy

Ledgers, receipts, and locks are written only to the designated state directory. The reconciliation command only moves matching, released `completed` receipts to the pending-acceptance state (`reviewing`); it never marks acceptance directly or dispatches the next task automatically.

The privacy scanner detects common sensitive information and cannot cover every case. Before sharing or publishing files, still review the file list, known private values, and the actual content.

## License

MIT — see [LICENSE](LICENSE).
