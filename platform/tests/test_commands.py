"""Tests for backend/commands.py slash command system."""
import sys
import tempfile
import json
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.commands import build_default_registry, CommandContext


def make_ctx(tmp_path=None, **kw) -> CommandContext:
    return CommandContext(
        cwd=str(tmp_path) if tmp_path else ".",
        config_path=str(tmp_path / "platform.json") if tmp_path else "config/platform.json",
        **kw,
    )


def test_help_lists_commands():
    reg = build_default_registry()
    ctx = make_ctx()
    result = reg.run("/help", ctx)
    assert "/help" in result
    assert "/config" in result
    assert "/commit" in result


def test_unknown_command():
    reg = build_default_registry()
    result = reg.run("/doesnotexist", make_ctx())
    assert "Unknown command" in result


def test_config_empty(tmp_path):
    reg = build_default_registry()
    ctx = make_ctx(tmp_path)
    result = reg.run("/config", ctx)
    assert result


def test_config_set_get(tmp_path):
    reg = build_default_registry()
    ctx = make_ctx(tmp_path)
    reg.run("/config set my_key my_value", ctx)
    result = reg.run("/config get my_key", ctx)
    assert "my_value" in result


def test_config_set_json(tmp_path):
    reg = build_default_registry()
    ctx = make_ctx(tmp_path)
    reg.run('/config set count 42', ctx)
    cfg = ctx.load_config()
    assert cfg.get("count") == 42


def test_init_creates_file(tmp_path):
    reg = build_default_registry()
    ctx = make_ctx(tmp_path)
    result = reg.run("/init", ctx)
    assert "CLAUDE.md" in result
    assert (tmp_path / "CLAUDE.md").exists()


def test_init_already_exists(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("# existing")
    reg = build_default_registry()
    ctx = make_ctx(tmp_path)
    result = reg.run("/init", ctx)
    assert "already exists" in result


def test_clear_history():
    reg = build_default_registry()
    ctx = make_ctx(history=[{"role": "user", "content": "hi"}])
    reg.run("/clear", ctx)
    assert ctx.history == []


def test_model_show():
    reg = build_default_registry()
    ctx = make_ctx(model="kimi-k3")
    result = reg.run("/model", ctx)
    assert "kimi-k3" in result


def test_model_set(tmp_path):
    reg = build_default_registry()
    ctx = make_ctx(tmp_path, model="old-model")
    reg.run("/model new-model", ctx)
    assert ctx.model == "new-model"


def test_history_empty():
    reg = build_default_registry()
    ctx = make_ctx()
    result = reg.run("/history", ctx)
    assert "(no history)" in result


def test_history_shows_entries():
    reg = build_default_registry()
    ctx = make_ctx(history=[
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "world"},
    ])
    result = reg.run("/history", ctx)
    assert "hello" in result
    assert "world" in result


def test_tools_command():
    reg = build_default_registry()
    ctx = make_ctx()
    result = reg.run("/tools", ctx)
    assert "bash" in result
    assert "file_read" in result


def test_exit_raises():
    reg = build_default_registry()
    ctx = make_ctx()
    with pytest.raises(SystemExit):
        reg.run("/exit", ctx)
