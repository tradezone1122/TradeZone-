"""Tests for backend/tool_registry.py — 10 core tools."""
import sys
import os
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.tool_registry import (
    BashTool, FileReadTool, FileWriteTool, FileEditTool,
    GlobTool, GrepTool, AskUserQuestionTool, TodoWriteTool,
    WebFetchTool, build_default_registry, ToolRegistry,
)


# ── BashTool ──────────────────────────────────────────────────────────────────

def test_bash_simple():
    result = BashTool().execute({"command": "echo hello"})
    assert not result.is_error
    assert "hello" in result.output


def test_bash_exit_nonzero():
    result = BashTool().execute({"command": "exit 1"})
    assert result.is_error


def test_bash_timeout():
    result = BashTool().execute({"command": "sleep 100", "timeout": 1})
    assert result.is_error
    assert "timed out" in result.error.lower()


# ── FileReadTool ──────────────────────────────────────────────────────────────

def test_file_read(tmp_path):
    p = tmp_path / "test.txt"
    p.write_text("line1\nline2\nline3\n")
    result = FileReadTool().execute({"path": str(p)})
    assert "line1" in result.output
    assert "line3" in result.output


def test_file_read_range(tmp_path):
    p = tmp_path / "test.txt"
    p.write_text("a\nb\nc\nd\n")
    result = FileReadTool().execute({"path": str(p), "start_line": 2, "end_line": 3})
    assert "b" in result.output
    assert "d" not in result.output


def test_file_read_missing():
    result = FileReadTool().execute({"path": "/nonexistent/path/file.txt"})
    assert result.is_error


# ── FileWriteTool ─────────────────────────────────────────────────────────────

def test_file_write(tmp_path):
    p = tmp_path / "out.txt"
    result = FileWriteTool().execute({"path": str(p), "content": "hello world"})
    assert not result.is_error
    assert p.read_text() == "hello world"


def test_file_write_creates_dirs(tmp_path):
    p = tmp_path / "deep" / "nested" / "file.txt"
    result = FileWriteTool().execute({"path": str(p), "content": "data"})
    assert not result.is_error
    assert p.read_text() == "data"


# ── FileEditTool ──────────────────────────────────────────────────────────────

def test_file_edit(tmp_path):
    p = tmp_path / "edit.py"
    p.write_text("def foo():\n    pass\n")
    result = FileEditTool().execute({
        "path": str(p),
        "old_string": "    pass",
        "new_string": "    return 42",
    })
    assert not result.is_error
    assert "return 42" in p.read_text()


def test_file_edit_not_found():
    result = FileEditTool().execute({
        "path": "/no/such/file.py",
        "old_string": "x",
        "new_string": "y",
    })
    assert result.is_error


def test_file_edit_ambiguous(tmp_path):
    p = tmp_path / "dup.py"
    p.write_text("x = 1\nx = 1\n")
    result = FileEditTool().execute({"path": str(p), "old_string": "x = 1", "new_string": "x = 2"})
    assert result.is_error
    assert "2 times" in result.error


# ── GlobTool ──────────────────────────────────────────────────────────────────

def test_glob(tmp_path):
    (tmp_path / "a.py").write_text("")
    (tmp_path / "b.py").write_text("")
    (tmp_path / "c.txt").write_text("")
    result = GlobTool().execute({"pattern": "*.py", "cwd": str(tmp_path)})
    assert "a.py" in result.output
    assert "b.py" in result.output
    assert "c.txt" not in result.output


def test_glob_no_match(tmp_path):
    result = GlobTool().execute({"pattern": "*.nonexistent", "cwd": str(tmp_path)})
    assert "(no matches)" in result.output


# ── GrepTool ──────────────────────────────────────────────────────────────────

def test_grep(tmp_path):
    (tmp_path / "code.py").write_text("def hello():\n    return 'world'\n")
    result = GrepTool().execute({"pattern": "def hello", "path": str(tmp_path)})
    assert "def hello" in result.output


def test_grep_no_match(tmp_path):
    (tmp_path / "file.py").write_text("nothing here\n")
    result = GrepTool().execute({"pattern": "xyz_missing", "path": str(tmp_path)})
    assert "(no matches)" in result.output


def test_grep_case_insensitive(tmp_path):
    (tmp_path / "f.txt").write_text("Hello World\n")
    result = GrepTool().execute({"pattern": "hello", "path": str(tmp_path), "ignore_case": True})
    assert "Hello" in result.output


# ── AskUserQuestionTool ───────────────────────────────────────────────────────

def test_ask_user_custom_fn():
    tool = AskUserQuestionTool(ask_fn=lambda q, opts: "yes")
    result = tool.execute({"question": "Are you sure?"})
    assert result.output == "yes"


# ── TodoWriteTool ─────────────────────────────────────────────────────────────

def test_todo_add_list():
    t = TodoWriteTool()
    t.execute({"action": "add", "item": "Write tests"})
    t.execute({"action": "add", "item": "Deploy"})
    result = t.execute({"action": "list"})
    assert "Write tests" in result.output
    assert "Deploy" in result.output


def test_todo_complete():
    t = TodoWriteTool()
    t.execute({"action": "add", "item": "Task one"})
    t.execute({"action": "complete", "item": "Task one"})
    result = t.execute({"action": "list"})
    assert "[x]" in result.output


def test_todo_clear():
    t = TodoWriteTool()
    t.execute({"action": "add", "item": "x"})
    result = t.execute({"action": "clear"})
    assert "Cleared" in result.output
    assert "(no todos)" in t.execute({"action": "list"}).output


# ── ToolRegistry ──────────────────────────────────────────────────────────────

def test_registry_all_tools():
    reg = build_default_registry()
    names = {t["function"]["name"] for t in reg.list_tools()}
    for expected in ["bash", "file_read", "file_write", "file_edit",
                     "glob", "grep", "web_fetch", "ask_user", "todo_write"]:
        assert expected in names, f"Missing tool: {expected}"


def test_registry_call_missing():
    reg = ToolRegistry()
    result = reg.call("nonexistent", {})
    assert result.is_error
    assert "not found" in result.error


def test_registry_call_bad_json():
    reg = build_default_registry()
    result = reg.call("bash", "not json {{{")
    assert result.is_error


def test_registry_to_openai_format():
    reg = build_default_registry()
    for tool_def in reg.list_tools():
        assert tool_def["type"] == "function"
        assert "name" in tool_def["function"]
        assert "description" in tool_def["function"]
        assert "parameters" in tool_def["function"]
