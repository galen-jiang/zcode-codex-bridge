import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from zcode_ui_guard import ZCodeUiGuard


MUTATING_CODE = """
await tools.mcp__node_repl__js({
  code: "await sky.click({app:'ZCode', element_index:42});"
})
"""

READ_ONLY_CODE = """
await tools.mcp__node_repl__js({
  code: "await sky.get_app_state({app:'ZCode'});"
})
"""

SEND_CODE = """
await tools.mcp__node_repl__js({
  code: "await sky.click({app:'ZCode', element_index:42}); await sky.get_app_state({app:'ZCode', disableDiff:true});",
  title: "发送 ZCode 提示词并验证"
})
"""


def pre_event(session_id, code=MUTATING_CODE, tool_name="functions.exec"):
    return {
        "hook_event_name": "PreToolUse",
        "session_id": session_id,
        "tool_name": tool_name,
        "tool_input": {"code": code},
    }


def post_event(session_id, code=SEND_CODE, response=None):
    return {
        "hook_event_name": "PostToolUse",
        "session_id": session_id,
        "tool_name": "functions.exec",
        "tool_input": {"code": code},
        "tool_response": response
        or {
            "isError": False,
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Window: ZCode\n"
                        "text entry area Placeholder: 继续输入, Value: \n"
                        "button 停止生成"
                    ),
                }
            ],
        },
    }


class ZCodeUiGuardTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.state_path = Path(self.tempdir.name) / "zcode-ui-lock.json"
        self.guard = ZCodeUiGuard(self.state_path, stale_after_seconds=120)

    def test_first_mutating_zcode_call_acquires_lock(self):
        self.assertIsNone(self.guard.handle(pre_event("session-a"), now=100))
        self.assertEqual("session-a", self._owner()["session_id"])

    def test_competing_session_is_denied_while_owner_is_active(self):
        self.guard.handle(pre_event("session-a"), now=100)

        response = self.guard.handle(pre_event("session-b"), now=101)

        output = response["hookSpecificOutput"]
        self.assertEqual("deny", output["permissionDecision"])
        self.assertIn("session-a", output["permissionDecisionReason"])
        self.assertEqual("session-a", self._owner()["session_id"])

    def test_owner_can_continue_and_refresh_last_action(self):
        self.guard.handle(pre_event("session-a"), now=100)
        self.assertIsNone(self.guard.handle(pre_event("session-a"), now=115))
        self.assertEqual(115, self._owner()["last_action_at"])

    def test_read_only_zcode_observation_does_not_acquire_lock(self):
        self.assertIsNone(self.guard.handle(pre_event("session-a", READ_ONLY_CODE), now=100))
        self.assertFalse(self.state_path.exists())

    def test_unrelated_app_mutation_does_not_acquire_lock(self):
        code = MUTATING_CODE.replace("ZCode", "Google Chrome")
        self.assertIsNone(self.guard.handle(pre_event("session-a", code), now=100))
        self.assertFalse(self.state_path.exists())

    def test_direct_node_repl_mutation_is_protected(self):
        event = pre_event(
            "session-a",
            "await sky.click({app:'ZCode', element_index:42})",
            tool_name="mcp__node_repl__js",
        )
        self.assertIsNone(self.guard.handle(event, now=100))
        self.assertEqual("session-a", self._owner()["session_id"])

    def test_verified_send_releases_lock(self):
        self.guard.handle(pre_event("session-a"), now=100)

        self.assertIsNone(self.guard.handle(post_event("session-a"), now=110))

        self.assertFalse(self.state_path.exists())

    def test_direct_node_repl_verified_send_releases_lock(self):
        self.guard.handle(pre_event("session-a"), now=100)
        event = post_event("session-a")
        event["tool_name"] = "mcp__node_repl__js"
        event["tool_input"] = {
            "code": (
                "await sky.click({app:'ZCode', element_index:42}); "
                "await sky.get_app_state({app:'ZCode', disableDiff:true});"
            ),
            "title": "发送 ZCode 提示词并验证",
        }

        self.assertIsNone(self.guard.handle(event, now=110))

        self.assertFalse(self.state_path.exists())

    def test_failed_send_keeps_lock(self):
        self.guard.handle(pre_event("session-a"), now=100)
        response = {"isError": True, "content": [{"type": "text", "text": "failed"}]}

        self.assertIsNone(self.guard.handle(post_event("session-a", response=response), now=110))

        self.assertEqual("session-a", self._owner()["session_id"])

    def test_non_send_post_tool_use_keeps_lock(self):
        self.guard.handle(pre_event("session-a"), now=100)
        event = post_event("session-a", code=MUTATING_CODE)

        self.assertIsNone(self.guard.handle(event, now=110))

        self.assertEqual("session-a", self._owner()["session_id"])

    def test_stop_interrupt_and_session_end_release_only_their_own_lock(self):
        for event_name in ("Stop", "Interrupt", "SessionEnd"):
            with self.subTest(event_name=event_name):
                self.guard.handle(pre_event("session-a"), now=100)
                foreign = {"hook_event_name": event_name, "session_id": "session-b"}
                self.assertIsNone(self.guard.handle(foreign, now=101))
                self.assertEqual("session-a", self._owner()["session_id"])

                owner = {"hook_event_name": event_name, "session_id": "session-a"}
                self.assertIsNone(self.guard.handle(owner, now=102))
                self.assertFalse(self.state_path.exists())

    def test_stale_lock_can_be_reclaimed(self):
        self.guard.handle(pre_event("session-a"), now=100)

        self.assertIsNone(self.guard.handle(pre_event("session-b"), now=221))

        self.assertEqual("session-b", self._owner()["session_id"])

    def test_corrupt_lock_denies_takeover(self):
        self.state_path.write_text("not-json\n", encoding="utf-8")

        response = self.guard.handle(pre_event("session-b"), now=221)

        output = response["hookSpecificOutput"]
        self.assertEqual("deny", output["permissionDecision"])
        self.assertIn("无法读取", output["permissionDecisionReason"])
        self.assertEqual("not-json\n", self.state_path.read_text(encoding="utf-8"))

    def _owner(self):
        return json.loads(self.state_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
