import fcntl
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path


MUTATING_SKY_CALL = re.compile(
    r"\bsky\.(click|drag|paste|perform_secondary_action|press_key|scroll|"
    r"select_text|set_value|type_text)\s*\("
)
ZCODE_TARGET = re.compile(r"(?:['\"]ZCode['\"]|dev\.zcode\.app)")
SEND_MARKER = "发送 ZCode 提示词并验证"
ACTIVE_ZCODE_MARKERS = (
    "停止生成",
    "工作中",
    "正在思考",
    "继续输入以排队后续修改",
)
RELEASE_EVENTS = frozenset(("Stop", "Interrupt", "SessionEnd"))
CUA_TOOL_NAMES = frozenset(("mcp__cua_repl.js", "mcp__cua_repl__js"))


class ZCodeUiGuard:
    def __init__(self, state_path, stale_after_seconds=120):
        self.state_path = Path(state_path)
        self.guard_path = self.state_path.with_suffix(self.state_path.suffix + ".guard")
        self.stale_after_seconds = stale_after_seconds

    def handle(self, event, now=None):
        now = time.time() if now is None else now
        event_name = event.get("hook_event_name")
        session_id = event.get("session_id")

        if event_name in RELEASE_EVENTS:
            if isinstance(session_id, str) and session_id:
                with self._locked():
                    owner = self._read_owner()
                    if owner is not None and owner.get("session_id") == session_id:
                        self._release()
            return None

        if event_name == "PreToolUse" and (
            self._is_cua_tool(event) or self._is_zcode_mutation(event)
        ):
            if not isinstance(session_id, str) or not session_id:
                return self._denial("ZCode UI 操作缺少 Codex session_id，已拒绝。")
            with self._locked():
                owner = self._read_owner()
                if owner is not None and owner.get("unreadable") is True:
                    return self._denial(
                        "ZCode UI 锁文件无法读取，已拒绝接管；请检查或清理锁状态。"
                    )
                if owner is None or self._is_stale(owner, now):
                    self._write_owner(self._new_owner(event, session_id, now))
                    return None
                if owner.get("session_id") == session_id:
                    owner["last_action_at"] = now
                    self._write_owner(owner)
                    return None
                return self._denial(
                    "ZCode UI 正由 Codex 会话 {0} 操作；请等待其发送提示词并释放。".format(
                        owner.get("session_id", "unknown")
                    )
                )

        if event_name == "PostToolUse" and (
            self._is_cua_tool(event) or self._is_zcode_mutation(event)
        ):
            if not isinstance(session_id, str) or not session_id:
                return None
            with self._locked():
                owner = self._read_owner()
                if owner is None or owner.get("session_id") != session_id:
                    return None
                if self._is_send_call(event) and self._verified_send(event.get("tool_response")):
                    self._release()
                else:
                    owner["last_action_at"] = now
                    self._write_owner(owner)
            return None

        return None

    def _is_cua_tool(self, event):
        return event.get("tool_name") in CUA_TOOL_NAMES

    def _is_zcode_mutation(self, event):
        tool_name = event.get("tool_name")
        if tool_name not in ("functions.exec", "mcp__node_repl__js"):
            return False
        tool_input = event.get("tool_input")
        if not isinstance(tool_input, dict):
            return False
        code = tool_input.get("code")
        return (
            isinstance(code, str)
            and ZCODE_TARGET.search(code) is not None
            and MUTATING_SKY_CALL.search(code) is not None
        )

    def _is_send_call(self, event):
        tool_input = event.get("tool_input")
        if not isinstance(tool_input, dict):
            return False
        return any(
            isinstance(value, str) and SEND_MARKER in value
            for value in (tool_input.get("code"), tool_input.get("title"))
        )

    def _verified_send(self, response):
        if self._contains_error(response):
            return False
        text = "\n".join(self._string_values(response))
        input_cleared = re.search(
            r"text entry area[^\n]*Value:\s*$",
            text,
            flags=re.MULTILINE,
        ) is not None
        active = any(marker in text for marker in ACTIVE_ZCODE_MARKERS)
        target_is_zcode = any(
            marker in text for marker in ("Window: ZCode", 'Window: "ZCode"', "App: ZCode")
        )
        return target_is_zcode and input_cleared and active

    def _contains_error(self, value):
        if isinstance(value, dict):
            if value.get("isError") is True or value.get("is_error") is True:
                return True
            return any(self._contains_error(item) for item in value.values())
        if isinstance(value, list):
            return any(self._contains_error(item) for item in value)
        return False

    def _string_values(self, value):
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for item in value.values():
                yield from self._string_values(item)
        elif isinstance(value, list):
            for item in value:
                yield from self._string_values(item)

    def _new_owner(self, event, session_id, now):
        return {
            "version": 1,
            "session_id": session_id,
            "cwd": event.get("cwd"),
            "started_at": now,
            "last_action_at": now,
        }

    def _is_stale(self, owner, now):
        last_action = owner.get("last_action_at")
        return not isinstance(last_action, (int, float)) or now - last_action > self.stale_after_seconds

    @contextmanager
    def _locked(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.guard_path.open("a+", encoding="utf-8") as guard_file:
            os.chmod(self.guard_path, 0o600)
            fcntl.flock(guard_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(guard_file.fileno(), fcntl.LOCK_UN)

    def _read_owner(self):
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            return {"unreadable": True}
        return value if isinstance(value, dict) else {"unreadable": True}

    def _write_owner(self, owner):
        temporary = self.state_path.with_name(
            ".{0}.{1}.tmp".format(self.state_path.name, os.getpid())
        )
        temporary.write_text(
            json.dumps(owner, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.state_path)

    def _release(self):
        try:
            self.state_path.unlink()
        except FileNotFoundError:
            pass

    def _denial(self, reason):
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }


def main(stdin=sys.stdin, stdout=sys.stdout):
    try:
        event = json.load(stdin)
    except (TypeError, ValueError):
        return 2
    if not isinstance(event, dict):
        return 2

    state_path = Path(
        os.environ.get(
            "CODEX_ZCODE_UI_STATE_PATH",
            str(Path.home() / ".codex" / "state" / "zcode-ui-lock.json"),
        )
    )
    response = ZCodeUiGuard(state_path).handle(event)
    if response is not None:
        json.dump(response, stdout, ensure_ascii=False)
        stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
