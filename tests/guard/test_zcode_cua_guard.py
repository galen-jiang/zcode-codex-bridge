import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


HOOK = Path(__file__).resolve().parents[2] / "scripts" / "zcode_ui_guard.py"
CUA_TOOL_NAMES = ("mcp__cua_repl.js", "mcp__cua_repl__js")
MISSING = object()


def tool_event(
    session_id,
    *,
    tool_name="mcp__cua_repl.js",
    code="await cua.getState()",
    phase="PreToolUse",
    title=None,
    response=None,
):
    tool_input = {}
    if code is not MISSING:
        tool_input["code"] = code
    if title is not None:
        tool_input["title"] = title
    event = {
        "hook_event_name": phase,
        "session_id": session_id,
        "tool_name": tool_name,
        "tool_input": tool_input,
    }
    if response is not None:
        event["tool_response"] = response
    return event


def invoke(state_path, event):
    completed = subprocess.run(
        [sys.executable, "-B", str(HOOK)],
        input=json.dumps(event, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "CODEX_ZCODE_UI_STATE_PATH": str(state_path)},
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout) if completed.stdout.strip() else None


def owner(state_path):
    return json.loads(state_path.read_text(encoding="utf-8"))


class ZCodeCuaToolBoundaryTests(unittest.TestCase):
    def test_supported_cua_entries_lock_without_inspecting_code(self):
        code_shapes = (MISSING, None, 7, "", "1 + 1", "await cua.getState()")
        for tool_name in CUA_TOOL_NAMES:
            for code in code_shapes:
                with self.subTest(tool_name=tool_name, code=code):
                    with tempfile.TemporaryDirectory() as directory:
                        state_path = Path(directory) / "ui-lock.json"

                        self.assertIsNone(
                            invoke(
                                state_path,
                                tool_event("session-a", tool_name=tool_name, code=code),
                            )
                        )

                        self.assertEqual("session-a", owner(state_path)["session_id"])

    def test_dynamic_cua_syntax_cannot_bypass_a_foreign_lock(self):
        calls = (
            'const operation = "click"; await app[operation]({x: 1, y: 1})',
            "await app.click?.({x: 1, y: 1})",
            "await app.click/*target*/({x: 1, y: 1})",
            "await savedMethod({x: 1, y: 1})",
        )
        for code in calls:
            with self.subTest(code=code):
                with tempfile.TemporaryDirectory() as directory:
                    state_path = Path(directory) / "ui-lock.json"
                    invoke(state_path, tool_event("session-a", code="await cua.getState()"))

                    response = invoke(state_path, tool_event("session-b", code=code))

                    output = response["hookSpecificOutput"]
                    self.assertEqual("deny", output["permissionDecision"])
                    self.assertIn("session-a", output["permissionDecisionReason"])
                    self.assertEqual("session-a", owner(state_path)["session_id"])

    def test_missing_session_is_denied_before_any_cua_code_is_considered(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "ui-lock.json"

            response = invoke(state_path, tool_event(None, code=MISSING))

            self.assertEqual(
                "deny",
                response["hookSpecificOutput"]["permissionDecision"],
            )
            self.assertFalse(state_path.exists())

    def test_corrupt_lock_denies_a_cua_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "ui-lock.json"
            state_path.write_text("not-json\n", encoding="utf-8")

            response = invoke(state_path, tool_event("session-b"))

            self.assertEqual(
                "deny",
                response["hookSpecificOutput"]["permissionDecision"],
            )
            self.assertEqual("not-json\n", state_path.read_text(encoding="utf-8"))

    def test_stale_cua_owner_can_be_reclaimed(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "ui-lock.json"
            state_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "session_id": "session-a",
                        "cwd": "/tmp/a",
                        "started_at": 1,
                        "last_action_at": time.time() - 121,
                    }
                ),
                encoding="utf-8",
            )

            self.assertIsNone(invoke(state_path, tool_event("session-b")))

            self.assertEqual("session-b", owner(state_path)["session_id"])

    def test_cua_post_tool_use_refreshes_the_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "ui-lock.json"
            invoke(state_path, tool_event("session-a"))
            before = owner(state_path)["last_action_at"]

            self.assertIsNone(
                invoke(
                    state_path,
                    tool_event(
                        "session-a",
                        phase="PostToolUse",
                        response={"isError": False, "content": []},
                    ),
                )
            )

            self.assertGreaterEqual(owner(state_path)["last_action_at"], before)

    def test_verified_cua_send_releases_the_owner(self):
        for target_marker in ('App: ZCode', 'Window: "ZCode"'):
            with self.subTest(target_marker=target_marker):
                with tempfile.TemporaryDirectory() as directory:
                    state_path = Path(directory) / "ui-lock.json"
                    invoke(state_path, tool_event("session-a"))
                    self.assertEqual("session-a", owner(state_path)["session_id"])
                    response = {
                        "isError": False,
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    f"{target_marker}\n"
                                    "text entry area Placeholder: 继续输入, Value: \n"
                                    "button 停止生成"
                                ),
                            }
                        ],
                    }

                    self.assertIsNone(
                        invoke(
                            state_path,
                            tool_event(
                                "session-a",
                                phase="PostToolUse",
                                title="发送 ZCode 提示词并验证",
                                response=response,
                            ),
                        )
                    )

                    self.assertFalse(state_path.exists())

    def test_failed_cua_send_keeps_the_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "ui-lock.json"
            invoke(state_path, tool_event("session-a"))

            self.assertIsNone(
                invoke(
                    state_path,
                    tool_event(
                        "session-a",
                        phase="PostToolUse",
                        title="发送 ZCode 提示词并验证",
                        response={"isError": True, "content": []},
                    ),
                )
            )

            self.assertEqual("session-a", owner(state_path)["session_id"])

    def test_foreign_cua_post_cannot_release_the_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "ui-lock.json"
            invoke(state_path, tool_event("session-a"))

            self.assertIsNone(
                invoke(
                    state_path,
                    tool_event(
                        "session-b",
                        phase="PostToolUse",
                        title="发送 ZCode 提示词并验证",
                        response={
                            "isError": False,
                            "content": [
                                {
                                    "type": "text",
                                    "text": (
                                        "App: ZCode\n"
                                        "text entry area Value: \n"
                                        "button 停止生成"
                                    ),
                                }
                            ],
                        },
                    ),
                )
            )

            self.assertEqual("session-a", owner(state_path)["session_id"])

    def test_non_cua_tool_is_not_serialized(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "ui-lock.json"

            self.assertIsNone(
                invoke(
                    state_path,
                    tool_event(
                        "session-a",
                        tool_name="functions.exec",
                        code="await unrelated.click()",
                    ),
                )
            )

            self.assertFalse(state_path.exists())


if __name__ == "__main__":
    unittest.main()
