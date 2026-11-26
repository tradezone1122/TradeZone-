"""Tests for backend/file_tools.py — P1"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_tmp_storage = tempfile.mkdtemp(prefix="up_ft_test_")
os.environ["UP_STORAGE"] = _tmp_storage
import backend.settings as _settings
_settings.STORAGE = Path(_tmp_storage)

from backend.workspaces import WorkspaceManager, WorkspaceError
import backend.workspaces as _wm
from backend import file_tools


@pytest.fixture
def ws(tmp_path):
    ws_dir = tmp_path / "workspaces"
    sn_dir = tmp_path / "snapshots"
    ws_dir.mkdir()
    sn_dir.mkdir()
    orig_ws, orig_sn = _wm.WORKSPACES_DIR, _wm.SNAPSHOTS_DIR
    _wm.WORKSPACES_DIR = ws_dir
    _wm.SNAPSHOTS_DIR  = sn_dir
    mgr = WorkspaceManager.__new__(WorkspaceManager)
    mgr._workspaces = {}
    _wm._manager = mgr
    # create a snapshot workspace from a plain dir
    source = tmp_path / "src"
    source.mkdir()
    (source / "readme.txt").write_text("hello world")
    (source / "sub").mkdir()
    (source / "sub" / "nested.py").write_text("x = 1\n")
    ws_obj = mgr.create("run0", "task0", str(source))
    yield ws_obj
    _wm.WORKSPACES_DIR = orig_ws
    _wm.SNAPSHOTS_DIR  = orig_sn
    _wm._manager = None


# ── read_file ──────────────────────────────────────────────────────────────────

def test_read_existing(ws):
    content = file_tools.read_file(ws.id, "readme.txt")
    assert content == "hello world"


def test_read_missing_raises(ws):
    with pytest.raises(FileNotFoundError):
        file_tools.read_file(ws.id, "nope.txt")


def test_read_escape_blocked(ws):
    with pytest.raises(WorkspaceError):
        file_tools.read_file(ws.id, "../../etc/passwd")


# ── write_file ─────────────────────────────────────────────────────────────────

def test_write_new_file(ws):
    n = file_tools.write_file(ws.id, "new.txt", "data123")
    assert n == len("data123")
    assert (ws.root / "new.txt").read_text() == "data123"


def test_write_creates_subdirs(ws):
    file_tools.write_file(ws.id, "a/b/c.txt", "deep")
    assert (ws.root / "a" / "b" / "c.txt").read_text() == "deep"


def test_write_overwrites(ws):
    file_tools.write_file(ws.id, "readme.txt", "new content")
    assert (ws.root / "readme.txt").read_text() == "new content"


# ── append_file ───────────────────────────────────────────────────────────────

def test_append_file(ws):
    file_tools.write_file(ws.id, "log.txt", "line1\n")
    file_tools.append_file(ws.id, "log.txt", "line2\n")
    assert (ws.root / "log.txt").read_text() == "line1\nline2\n"


def test_append_missing_raises(ws):
    with pytest.raises(FileNotFoundError):
        file_tools.append_file(ws.id, "missing.txt", "x")


# ── delete_file ───────────────────────────────────────────────────────────────

def test_delete_file(ws):
    assert file_tools.delete_file(ws.id, "readme.txt") is True
    assert not (ws.root / "readme.txt").exists()


def test_delete_missing_returns_false(ws):
    assert file_tools.delete_file(ws.id, "ghost.txt") is False


def test_delete_dir_raises(ws):
    with pytest.raises(IsADirectoryError):
        file_tools.delete_file(ws.id, "sub")


# ── list_dir ──────────────────────────────────────────────────────────────────

def test_list_dir_root(ws):
    entries = file_tools.list_dir(ws.id, ".")
    names = [e["name"] for e in entries]
    assert "readme.txt" in names
    assert "sub" in names


def test_list_dir_subdir(ws):
    entries = file_tools.list_dir(ws.id, "sub")
    assert any(e["name"] == "nested.py" for e in entries)


def test_list_dir_missing_raises(ws):
    with pytest.raises(FileNotFoundError):
        file_tools.list_dir(ws.id, "nonexistent")


# ── make_dir ──────────────────────────────────────────────────────────────────

def test_make_dir(ws):
    file_tools.make_dir(ws.id, "new/nested/dir")
    assert (ws.root / "new" / "nested" / "dir").is_dir()


# ── file_exists ───────────────────────────────────────────────────────────────

def test_file_exists_true(ws):
    assert file_tools.file_exists(ws.id, "readme.txt") is True


def test_file_exists_false(ws):
    assert file_tools.file_exists(ws.id, "nope.xyz") is False


def test_file_exists_escape_returns_false(ws):
    # escape attempts should return False, not raise
    assert file_tools.file_exists(ws.id, "../../etc/passwd") is False


# ── file_info ─────────────────────────────────────────────────────────────────

def test_file_info(ws):
    info = file_tools.file_info(ws.id, "readme.txt")
    assert info["name"] == "readme.txt"
    assert info["type"] == "file"
    assert info["size"] == len("hello world")


def test_file_info_dir(ws):
    info = file_tools.file_info(ws.id, "sub")
    assert info["type"] == "dir"


def test_file_info_missing_raises(ws):
    with pytest.raises(FileNotFoundError):
        file_tools.file_info(ws.id, "missing.txt")


# ── dispatch ──────────────────────────────────────────────────────────────────

def test_dispatch_read(ws):
    result = file_tools.dispatch(ws.id, "read_file", {"relative": "readme.txt"})
    assert result == "hello world"


def test_dispatch_unknown_tool(ws):
    with pytest.raises(ValueError, match="unknown file tool"):
        file_tools.dispatch(ws.id, "rm_rf", {"relative": "."})
