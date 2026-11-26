"""Tests for backend/context_manager.py"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.context_manager import ContextManager


def test_gather_context_returns_string():
    ctx = ContextManager(".")
    result = ctx.gather_context()
    assert isinstance(result, str)
    assert len(result) > 0


def test_gather_context_has_os():
    ctx = ContextManager(".")
    result = ctx.gather_context()
    assert "OS:" in result or "Working directory" in result


def test_gather_memory_empty(tmp_path):
    ctx = ContextManager(str(tmp_path))
    result = ctx.gather_memory()
    assert result == ""


def test_gather_memory_reads_claude_md(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("# My Project\nThis is a test project.\n")
    ctx = ContextManager(str(tmp_path))
    result = ctx.gather_memory()
    assert "My Project" in result
    assert "test project" in result


def test_gather_memory_reads_dot_claude_md(tmp_path):
    (tmp_path / ".claude.md").write_text("# Hidden Config\nSome notes.\n")
    ctx = ContextManager(str(tmp_path))
    result = ctx.gather_memory()
    assert "Hidden Config" in result


def test_build_system_prompt_has_parts(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("# Project: TestApp\nLanguage: Python\n")
    ctx = ContextManager(str(tmp_path))
    prompt = ctx.build_system_prompt()
    assert isinstance(prompt, str)
    assert len(prompt) > 50
    assert "TestApp" in prompt


def test_build_system_prompt_custom_instructions(tmp_path):
    ctx = ContextManager(str(tmp_path))
    prompt = ctx.build_system_prompt(base_instructions="Custom instructions here.")
    assert "Custom instructions here." in prompt


def test_build_system_prompt_extra_context(tmp_path):
    ctx = ContextManager(str(tmp_path))
    prompt = ctx.build_system_prompt(extra_context="Extra: session_id=abc123")
    assert "session_id=abc123" in prompt
