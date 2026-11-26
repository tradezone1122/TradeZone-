"""
Independent Python implementation of a Claude Code-style tool system.
Built from architecture patterns in official documentation — no Anthropic code copied.

Tool interface:
  name         str
  description  str
  input_schema JSON Schema dict
  permission   PermissionLevel
  execute(args: dict) -> ToolResult

Usage:
    registry = ToolRegistry()
    registry.register(BashTool())
    result = registry.call("bash", {"command": "ls -la"})
"""
from __future__ import annotations

import glob as _glob
import json
import os
import re
import subprocess
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class PermissionLevel(Enum):
    SAFE   = "safe"    # auto-approve
    ASK    = "ask"     # ask user each time
    NEVER  = "never"   # always deny


@dataclass
class ToolResult:
    output: str
    error: str = ""
    is_error: bool = False

    def __str__(self) -> str:
        return self.error if self.is_error else self.output


class BaseTool(ABC):
    name: str
    description: str
    input_schema: dict
    permission: PermissionLevel = PermissionLevel.SAFE

    def to_openai(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }

    @abstractmethod
    def execute(self, args: dict) -> ToolResult:
        ...

    def _ok(self, text: str) -> ToolResult:
        return ToolResult(output=text)

    def _err(self, msg: str) -> ToolResult:
        return ToolResult(output="", error=msg, is_error=True)


# ── BashTool ──────────────────────────────────────────────────────────────────

class BashTool(BaseTool):
    name = "bash"
    description = "Execute a shell command and return its output. Use for file ops, running code, system inspection."
    permission = PermissionLevel.ASK
    input_schema = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "Shell command to run"},
            "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"},
        },
        "required": ["command"],
    }

    def execute(self, args: dict) -> ToolResult:
        cmd = args.get("command", "")
        timeout = int(args.get("timeout", 30))
        try:
            proc = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=timeout
            )
            out = proc.stdout
            err = proc.stderr
            if proc.returncode != 0:
                return ToolResult(output=out, error=err or f"Exit code {proc.returncode}", is_error=True)
            return ToolResult(output=out + (("/n" + err) if err else ""))
        except subprocess.TimeoutExpired:
            return self._err(f"Command timed out after {timeout}s")
        except Exception as exc:
            return self._err(str(exc))


# ── FileReadTool ──────────────────────────────────────────────────────────────

class FileReadTool(BaseTool):
    name = "file_read"
    description = "Read a file's contents. Supports optional line range."
    permission = PermissionLevel.SAFE
    input_schema = {
        "type": "object",
        "properties": {
            "path":       {"type": "string", "description": "File path to read"},
            "start_line": {"type": "integer", "description": "1-indexed start line"},
            "end_line":   {"type": "integer", "description": "1-indexed end line (inclusive)"},
        },
        "required": ["path"],
    }

    def execute(self, args: dict) -> ToolResult:
        path = Path(args["path"])
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
        except FileNotFoundError:
            return self._err(f"File not found: {path}")
        except Exception as exc:
            return self._err(str(exc))

        start = args.get("start_line")
        end   = args.get("end_line")
        if start is not None:
            s = max(0, int(start) - 1)
            e = int(end) if end is not None else len(lines)
            lines = lines[s:e]

        return self._ok("".join(lines))


# ── FileWriteTool ─────────────────────────────────────────────────────────────

class FileWriteTool(BaseTool):
    name = "file_write"
    description = "Write content to a file. Creates parent directories automatically."
    permission = PermissionLevel.ASK
    input_schema = {
        "type": "object",
        "properties": {
            "path":    {"type": "string", "description": "File path to write"},
            "content": {"type": "string", "description": "File content"},
        },
        "required": ["path", "content"],
    }

    def execute(self, args: dict) -> ToolResult:
        path = Path(args["path"])
        content = args["content"]
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            return self._ok(f"Wrote {len(content)} bytes to {path}")
        except Exception as exc:
            return self._err(str(exc))


# ── FileEditTool ──────────────────────────────────────────────────────────────

class FileEditTool(BaseTool):
    name = "file_edit"
    description = "Edit a file by replacing old_string with new_string (must be exact match, unique in file)."
    permission = PermissionLevel.ASK
    input_schema = {
        "type": "object",
        "properties": {
            "path":       {"type": "string", "description": "File to edit"},
            "old_string": {"type": "string", "description": "Exact text to replace"},
            "new_string": {"type": "string", "description": "Replacement text"},
        },
        "required": ["path", "old_string", "new_string"],
    }

    def execute(self, args: dict) -> ToolResult:
        path = Path(args["path"])
        old  = args["old_string"]
        new  = args["new_string"]
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return self._err(f"File not found: {path}")

        count = text.count(old)
        if count == 0:
            return self._err("old_string not found in file")
        if count > 1:
            return self._err(f"old_string found {count} times — must be unique")

        path.write_text(text.replace(old, new, 1), encoding="utf-8")
        return self._ok(f"Replaced 1 occurrence in {path}")


# ── GlobTool ──────────────────────────────────────────────────────────────────

class GlobTool(BaseTool):
    name = "glob"
    description = "Find files matching a glob pattern. Returns sorted list of matching paths."
    permission = PermissionLevel.SAFE
    input_schema = {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "Glob pattern, e.g. **/*.py"},
            "cwd":     {"type": "string", "description": "Base directory (default: .)"},
        },
        "required": ["pattern"],
    }

    def execute(self, args: dict) -> ToolResult:
        pattern = args["pattern"]
        cwd = args.get("cwd", ".")
        try:
            matches = sorted(_glob.glob(pattern, root_dir=cwd, recursive=True))
            if not matches:
                return self._ok("(no matches)")
            return self._ok("\n".join(matches))
        except Exception as exc:
            return self._err(str(exc))


# ── GrepTool ──────────────────────────────────────────────────────────────────

class GrepTool(BaseTool):
    name = "grep"
    description = "Search file contents with a regex pattern. Returns matching lines with file:line."
    permission = PermissionLevel.SAFE
    input_schema = {
        "type": "object",
        "properties": {
            "pattern":     {"type": "string", "description": "Regex pattern to search"},
            "path":        {"type": "string", "description": "File or directory to search"},
            "file_glob":   {"type": "string", "description": "Glob to filter files, e.g. *.py"},
            "ignore_case": {"type": "boolean", "description": "Case-insensitive search"},
            "max_results": {"type": "integer", "description": "Max lines to return (default 100)"},
        },
        "required": ["pattern"],
    }

    def execute(self, args: dict) -> ToolResult:
        pattern    = args["pattern"]
        base_path  = Path(args.get("path", "."))
        file_glob  = args.get("file_glob", "*")
        flags      = re.IGNORECASE if args.get("ignore_case") else 0
        max_res    = int(args.get("max_results", 100))

        try:
            regex = re.compile(pattern, flags)
        except re.error as exc:
            return self._err(f"Invalid regex: {exc}")

        if base_path.is_file():
            files = [base_path]
        else:
            files = list(base_path.rglob(file_glob))

        results = []
        for f in files:
            if not f.is_file():
                continue
            try:
                for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                    if regex.search(line):
                        results.append(f"{f}:{i}: {line}")
                        if len(results) >= max_res:
                            results.append(f"(truncated at {max_res} results)")
                            return self._ok("\n".join(results))
            except Exception:
                continue

        if not results:
            return self._ok("(no matches)")
        return self._ok("\n".join(results))


# ── AgentTool ─────────────────────────────────────────────────────────────────

class AgentTool(BaseTool):
    name = "agent"
    description = "Spawn a sub-agent to handle a subtask. Returns the agent's final answer."
    permission = PermissionLevel.SAFE
    input_schema = {
        "type": "object",
        "properties": {
            "task":        {"type": "string", "description": "Task description for the sub-agent"},
            "agent_name":  {"type": "string", "description": "Agent from pool (researcher/coder/planner/writer/analyst)"},
        },
        "required": ["task"],
    }

    def __init__(self, pool=None):
        self._pool = pool

    def execute(self, args: dict) -> ToolResult:
        task       = args.get("task", "")
        agent_name = args.get("agent_name", "researcher")
        if self._pool is None:
            return self._err("AgentTool: no agent pool configured")
        result = self._pool.run(agent_name, task)
        return self._ok(str(result))


# ── WebFetchTool ──────────────────────────────────────────────────────────────

class WebFetchTool(BaseTool):
    name = "web_fetch"
    description = "Fetch a URL and return its text content."
    permission = PermissionLevel.ASK
    input_schema = {
        "type": "object",
        "properties": {
            "url":        {"type": "string", "description": "URL to fetch"},
            "max_bytes":  {"type": "integer", "description": "Max bytes to read (default 32768)"},
        },
        "required": ["url"],
    }

    def execute(self, args: dict) -> ToolResult:
        url       = args["url"]
        max_bytes = int(args.get("max_bytes", 32768))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ai-platform/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read(max_bytes)
            text = data.decode("utf-8", errors="replace")
            return self._ok(text)
        except Exception as exc:
            return self._err(str(exc))


# ── AskUserQuestionTool ───────────────────────────────────────────────────────

class AskUserQuestionTool(BaseTool):
    name = "ask_user"
    description = "Ask the user a clarifying question and wait for their answer."
    permission = PermissionLevel.SAFE
    input_schema = {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "Question to ask the user"},
            "options":  {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional list of choices",
            },
        },
        "required": ["question"],
    }

    def __init__(self, ask_fn=None):
        self._ask = ask_fn or self._default_ask

    @staticmethod
    def _default_ask(question: str, options: list[str]) -> str:
        if options:
            print(f"\n{question}")
            for i, opt in enumerate(options, 1):
                print(f"  {i}. {opt}")
            return input("Answer: ").strip()
        return input(f"\n{question}\nAnswer: ").strip()

    def execute(self, args: dict) -> ToolResult:
        question = args["question"]
        options  = args.get("options", [])
        answer   = self._ask(question, options)
        return self._ok(answer)


# ── TodoWriteTool ─────────────────────────────────────────────────────────────

class TodoWriteTool(BaseTool):
    name = "todo_write"
    description = "Manage a simple todo list. actions: add, complete, list, clear."
    permission = PermissionLevel.SAFE
    input_schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["add", "complete", "list", "clear"],
                "description": "Todo operation",
            },
            "item": {"type": "string", "description": "Todo text (required for add/complete)"},
        },
        "required": ["action"],
    }

    def __init__(self):
        self._todos: list[dict] = []
        self._next_id = 1

    def execute(self, args: dict) -> ToolResult:
        action = args.get("action", "list")
        item   = args.get("item", "")

        if action == "add":
            if not item:
                return self._err("item required for add")
            self._todos.append({"id": self._next_id, "text": item, "done": False})
            self._next_id += 1
            return self._ok(f"Added todo #{self._next_id - 1}: {item}")

        if action == "complete":
            if not item:
                return self._err("item required for complete (text or id)")
            for todo in self._todos:
                if str(todo["id"]) == item or item.lower() in todo["text"].lower():
                    todo["done"] = True
                    return self._ok(f"Completed: {todo['text']}")
            return self._err(f"Todo not found: {item}")

        if action == "list":
            if not self._todos:
                return self._ok("(no todos)")
            lines = []
            for t in self._todos:
                mark = "[x]" if t["done"] else "[ ]"
                lines.append(f"{t['id']}. {mark} {t['text']}")
            return self._ok("\n".join(lines))

        if action == "clear":
            count = len(self._todos)
            self._todos.clear()
            return self._ok(f"Cleared {count} todos")

        return self._err(f"Unknown action: {action}")


# ── ToolRegistry ──────────────────────────────────────────────────────────────

class ToolRegistry:
    """Central registry for all tools."""

    def __init__(self):
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> BaseTool | None:
        return self._tools.get(name)

    def list_tools(self) -> list[dict]:
        return [t.to_openai() for t in self._tools.values()]

    def call(self, name: str, args: dict | str) -> ToolResult:
        tool = self._tools.get(name)
        if tool is None:
            return ToolResult(output="", error=f"Tool '{name}' not found", is_error=True)
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError as exc:
                return ToolResult(output="", error=f"Invalid JSON args: {exc}", is_error=True)
        try:
            return tool.execute(args)
        except Exception as exc:
            return ToolResult(output="", error=f"Tool error: {exc}", is_error=True)

    def call_json(self, name: str, args: dict | str) -> str:
        result = self.call(name, args)
        if result.is_error:
            return json.dumps({"error": result.error})
        return result.output


def build_default_registry(agent_pool=None) -> ToolRegistry:
    """Build registry with all 10 core tools."""
    registry = ToolRegistry()
    registry.register(BashTool())
    registry.register(FileReadTool())
    registry.register(FileWriteTool())
    registry.register(FileEditTool())
    registry.register(GlobTool())
    registry.register(GrepTool())
    registry.register(AgentTool(agent_pool))
    registry.register(WebFetchTool())
    registry.register(AskUserQuestionTool())
    registry.register(TodoWriteTool())
    return registry
