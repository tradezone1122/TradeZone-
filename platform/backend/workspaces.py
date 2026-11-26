"""
Workspace Isolation — P1
Inspired by agent-orchestrator (Apache-2.0) gitworktree adapter.

Each orchestrator task runs in its own isolated workspace:
  - Git project  → git worktree at storage/workspaces/<run>/<task>/
  - Non-git      → snapshot copy at storage/snapshots/<run>/<task>/

The workspace root is the ONLY path the task's sandbox is allowed to touch.
realpath() enforcement prevents escapes via symlinks or ../.. traversal.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import settings

WORKSPACES_DIR = settings.STORAGE / "workspaces"
SNAPSHOTS_DIR  = settings.STORAGE / "snapshots"


# ── Domain types ────────────────────────────────────────────────────────────

@dataclass
class Workspace:
    id: str
    run_id: str
    task_id: str
    kind: str          # "worktree" | "snapshot"
    root: Path         # absolute path of this workspace
    source: Path       # original project path
    branch: str        # git branch name (worktree only)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    destroyed: bool = False


class WorkspaceError(Exception):
    pass


# ── WorkspaceManager ────────────────────────────────────────────────────────

class WorkspaceManager:
    """
    Create and destroy per-task isolated workspaces.
    Thread-safe: each call is independent; the filesystem is the lock.
    """

    def __init__(self):
        WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)
        SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
        self._workspaces: dict[str, Workspace] = {}

    # ── Public API ──────────────────────────────────────────────────────────

    def create(self, run_id: str, task_id: str, source_path: str) -> Workspace:
        """
        Create an isolated workspace for one task.
        Uses git worktree if source_path is inside a git repo,
        snapshot copy otherwise.
        """
        source = Path(source_path).resolve()
        if not source.exists():
            raise WorkspaceError(f"source path does not exist: {source}")

        ws_id = uuid.uuid4().hex[:12]

        if _is_git_repo(source):
            ws = self._create_worktree(ws_id, run_id, task_id, source)
        else:
            ws = self._create_snapshot(ws_id, run_id, task_id, source)

        self._workspaces[ws_id] = ws
        return ws

    def destroy(self, workspace_id: str) -> None:
        """Remove a workspace and release resources."""
        ws = self._workspaces.get(workspace_id)
        if not ws or ws.destroyed:
            return
        try:
            if ws.kind == "worktree":
                _git(ws.source, ["worktree", "remove", "--force", str(ws.root)])
            else:
                shutil.rmtree(ws.root, ignore_errors=True)
        except Exception:
            shutil.rmtree(ws.root, ignore_errors=True)
        ws.destroyed = True

    def destroy_run(self, run_id: str) -> int:
        """Destroy all workspaces belonging to a run. Returns count."""
        targets = [ws for ws in self._workspaces.values() if ws.run_id == run_id]
        for ws in targets:
            self.destroy(ws.id)
        return len(targets)

    def get(self, workspace_id: str) -> Optional[Workspace]:
        return self._workspaces.get(workspace_id)

    def list_active(self) -> list[Workspace]:
        return [ws for ws in self._workspaces.values() if not ws.destroyed]

    def safe_path(self, workspace_id: str, relative: str) -> Path:
        """
        Resolve <relative> inside the workspace root and enforce it stays inside.
        Raises WorkspaceError if the resolved path escapes the workspace.
        """
        ws = self._workspaces.get(workspace_id)
        if not ws or ws.destroyed:
            raise WorkspaceError(f"workspace {workspace_id!r} not found or destroyed")
        root = ws.root.resolve()
        target = (root / relative).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            raise WorkspaceError(
                f"path escape attempt: {relative!r} resolves outside workspace {root}"
            )
        return target

    # ── Internal ────────────────────────────────────────────────────────────

    def _create_worktree(
        self, ws_id: str, run_id: str, task_id: str, source: Path
    ) -> Workspace:
        dest = WORKSPACES_DIR / run_id / task_id
        dest.parent.mkdir(parents=True, exist_ok=True)
        branch = f"tz/{run_id[:8]}/{task_id[:8]}"
        try:
            _git(source, ["worktree", "add", "-b", branch, str(dest)])
        except WorkspaceError:
            # Branch may already exist on retry — use --detach
            _git(source, ["worktree", "add", "--detach", str(dest)])
            branch = ""
        return Workspace(
            id=ws_id, run_id=run_id, task_id=task_id,
            kind="worktree", root=dest, source=source, branch=branch,
        )

    def _create_snapshot(
        self, ws_id: str, run_id: str, task_id: str, source: Path
    ) -> Workspace:
        dest = SNAPSHOTS_DIR / run_id / task_id
        shutil.copytree(source, dest, symlinks=False, ignore_dangling_symlinks=True)
        return Workspace(
            id=ws_id, run_id=run_id, task_id=task_id,
            kind="snapshot", root=dest, source=source, branch="",
        )


# ── Helpers ─────────────────────────────────────────────────────────────────

def _is_git_repo(path: Path) -> bool:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=path, capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def _git(cwd: Path, args: list[str]) -> str:
    try:
        result = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise WorkspaceError(f"git {args[0]} timed out")
    if result.returncode != 0:
        raise WorkspaceError(f"git {args[0]} failed: {result.stderr.strip()[:300]}")
    return result.stdout.strip()


# ── Module-level singleton ───────────────────────────────────────────────────

_manager: Optional[WorkspaceManager] = None


def get_manager() -> WorkspaceManager:
    global _manager
    if _manager is None:
        _manager = WorkspaceManager()
    return _manager
