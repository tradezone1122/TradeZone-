"""Tests for backend/workspaces.py — P1"""
import os
import shutil
import subprocess
import sys
import tempfile
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# patch STORAGE to a temp dir before importing workspaces
_tmp_storage = tempfile.mkdtemp(prefix="up_ws_test_")
os.environ["UP_STORAGE"] = _tmp_storage

import importlib
import backend.settings as _settings
_settings.STORAGE = Path(_tmp_storage)

from backend.workspaces import (
    WorkspaceManager,
    WorkspaceError,
    _is_git_repo,
    get_manager,
)


@pytest.fixture
def manager(tmp_path):
    # each test gets a fresh manager with its own storage
    ws_dir = tmp_path / "workspaces"
    sn_dir = tmp_path / "snapshots"
    ws_dir.mkdir()
    sn_dir.mkdir()
    mgr = WorkspaceManager.__new__(WorkspaceManager)
    mgr._workspaces = {}
    # patch dirs
    import backend.workspaces as wm
    orig_ws, orig_sn = wm.WORKSPACES_DIR, wm.SNAPSHOTS_DIR
    wm.WORKSPACES_DIR = ws_dir
    wm.SNAPSHOTS_DIR  = sn_dir
    ws_dir.mkdir(parents=True, exist_ok=True)
    sn_dir.mkdir(parents=True, exist_ok=True)
    yield mgr
    wm.WORKSPACES_DIR = orig_ws
    wm.SNAPSHOTS_DIR  = orig_sn


@pytest.fixture
def git_project(tmp_path):
    """A minimal git repo to serve as source."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@test.com"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True, capture_output=True)
    (repo / "hello.txt").write_text("hello")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "init"], check=True, capture_output=True)
    return repo


@pytest.fixture
def plain_dir(tmp_path):
    d = tmp_path / "plain"
    d.mkdir()
    (d / "data.txt").write_text("content")
    return d


# ── _is_git_repo ─────────────────────────────────────────────────────────────

def test_is_git_repo_true(git_project):
    assert _is_git_repo(git_project) is True


def test_is_git_repo_false(plain_dir):
    assert _is_git_repo(plain_dir) is False


# ── Snapshot workspace (non-git) ─────────────────────────────────────────────

def test_snapshot_created(manager, plain_dir):
    ws = manager.create("run1", "task1", str(plain_dir))
    assert ws.kind == "snapshot"
    assert ws.root.exists()
    assert (ws.root / "data.txt").read_text() == "content"


def test_snapshot_destroy(manager, plain_dir):
    ws = manager.create("run1", "task1", str(plain_dir))
    root = ws.root
    manager.destroy(ws.id)
    assert not root.exists()
    assert ws.destroyed is True


def test_snapshot_double_destroy_safe(manager, plain_dir):
    ws = manager.create("run1", "task1", str(plain_dir))
    manager.destroy(ws.id)
    manager.destroy(ws.id)  # should not raise


# ── Git worktree workspace ────────────────────────────────────────────────────

def test_worktree_created(manager, git_project):
    ws = manager.create("runA", "taskA", str(git_project))
    assert ws.kind == "worktree"
    assert ws.root.exists()
    assert (ws.root / "hello.txt").exists()


def test_worktree_destroy(manager, git_project):
    ws = manager.create("runA", "taskA", str(git_project))
    root = ws.root
    manager.destroy(ws.id)
    assert not root.exists()


# ── safe_path ─────────────────────────────────────────────────────────────────

def test_safe_path_ok(manager, plain_dir):
    ws = manager.create("r", "t", str(plain_dir))
    p = manager.safe_path(ws.id, "data.txt")
    assert p == ws.root / "data.txt"


def test_safe_path_nested_ok(manager, plain_dir):
    ws = manager.create("r", "t", str(plain_dir))
    p = manager.safe_path(ws.id, "sub/dir/file.py")
    assert str(p).startswith(str(ws.root))


def test_safe_path_escape_blocked(manager, plain_dir):
    ws = manager.create("r", "t", str(plain_dir))
    with pytest.raises(WorkspaceError, match="escape"):
        manager.safe_path(ws.id, "../../etc/passwd")


def test_safe_path_abs_outside_blocked(manager, plain_dir):
    ws = manager.create("r", "t", str(plain_dir))
    with pytest.raises(WorkspaceError):
        manager.safe_path(ws.id, "/etc/passwd")


def test_safe_path_nonexistent_workspace(manager):
    with pytest.raises(WorkspaceError):
        manager.safe_path("doesnotexist", "file.txt")


# ── destroy_run ───────────────────────────────────────────────────────────────

def test_destroy_run(manager, plain_dir, tmp_path):
    plain2 = tmp_path / "plain2"
    plain2.mkdir()
    (plain2 / "x.txt").write_text("x")
    ws1 = manager.create("runX", "task1", str(plain_dir))
    ws2 = manager.create("runX", "task2", str(plain2))
    ws3 = manager.create("runY", "task1", str(plain_dir))
    count = manager.destroy_run("runX")
    assert count == 2
    assert ws1.destroyed
    assert ws2.destroyed
    assert not ws3.destroyed


# ── list_active ───────────────────────────────────────────────────────────────

def test_list_active(manager, plain_dir):
    ws1 = manager.create("r1", "t1", str(plain_dir))
    ws2 = manager.create("r2", "t2", str(plain_dir))
    active = manager.list_active()
    assert len(active) == 2
    manager.destroy(ws1.id)
    active = manager.list_active()
    assert len(active) == 1
    assert active[0].id == ws2.id


# ── source path validation ────────────────────────────────────────────────────

def test_missing_source_raises(manager, tmp_path):
    with pytest.raises(WorkspaceError, match="does not exist"):
        manager.create("r", "t", str(tmp_path / "nonexistent"))
