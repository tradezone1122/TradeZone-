"""
File tools for agent tasks — P1
Agents operate ONLY within their assigned workspace root.
All paths are validated via workspaces.safe_path() before any I/O.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Union

from .workspaces import WorkspaceError, get_manager


# ── Helpers ──────────────────────────────────────────────────────────────────

def _resolve(workspace_id: str, relative: str) -> Path:
    return get_manager().safe_path(workspace_id, relative)


# ── File operations ──────────────────────────────────────────────────────────

def read_file(workspace_id: str, relative: str, encoding: str = "utf-8") -> str:
    path = _resolve(workspace_id, relative)
    if not path.exists():
        raise FileNotFoundError(f"file not found in workspace: {relative!r}")
    if not path.is_file():
        raise IsADirectoryError(f"path is a directory: {relative!r}")
    return path.read_text(encoding=encoding, errors="replace")


def write_file(
    workspace_id: str,
    relative: str,
    content: str,
    encoding: str = "utf-8",
    mkdir: bool = True,
) -> int:
    path = _resolve(workspace_id, relative)
    if mkdir:
        path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding=encoding)
    return len(content.encode(encoding))


def append_file(
    workspace_id: str,
    relative: str,
    content: str,
    encoding: str = "utf-8",
) -> int:
    path = _resolve(workspace_id, relative)
    if not path.exists():
        raise FileNotFoundError(f"file not found: {relative!r}")
    with path.open("a", encoding=encoding) as fh:
        fh.write(content)
    return len(content.encode(encoding))


def delete_file(workspace_id: str, relative: str) -> bool:
    path = _resolve(workspace_id, relative)
    if not path.exists():
        return False
    if path.is_dir():
        raise IsADirectoryError(f"use delete_dir for directories: {relative!r}")
    path.unlink()
    return True


def list_dir(workspace_id: str, relative: str = ".") -> list[dict]:
    path = _resolve(workspace_id, relative)
    if not path.exists():
        raise FileNotFoundError(f"directory not found: {relative!r}")
    if not path.is_dir():
        raise NotADirectoryError(f"not a directory: {relative!r}")
    entries = []
    for item in sorted(path.iterdir()):
        stat = item.stat(follow_symlinks=False)
        entries.append({
            "name": item.name,
            "type": "dir" if item.is_dir() else "file",
            "size": stat.st_size if item.is_file() else None,
        })
    return entries


def make_dir(workspace_id: str, relative: str) -> None:
    path = _resolve(workspace_id, relative)
    path.mkdir(parents=True, exist_ok=True)


def delete_dir(workspace_id: str, relative: str, recursive: bool = False) -> bool:
    import shutil
    path = _resolve(workspace_id, relative)
    if not path.exists():
        return False
    if not path.is_dir():
        raise NotADirectoryError(f"not a directory: {relative!r}")
    if recursive:
        shutil.rmtree(path)
    else:
        path.rmdir()
    return True


def file_exists(workspace_id: str, relative: str) -> bool:
    try:
        path = _resolve(workspace_id, relative)
    except WorkspaceError:
        return False
    return path.exists()


def file_info(workspace_id: str, relative: str) -> dict:
    path = _resolve(workspace_id, relative)
    if not path.exists():
        raise FileNotFoundError(f"path not found: {relative!r}")
    stat = path.stat(follow_symlinks=False)
    return {
        "name": path.name,
        "type": "dir" if path.is_dir() else "file",
        "size": stat.st_size,
        "modified": stat.st_mtime,
    }


# ── Tool dispatch (for agent tool integration) ───────────────────────────────

TOOL_REGISTRY: dict[str, callable] = {
    "read_file":   read_file,
    "write_file":  write_file,
    "append_file": append_file,
    "delete_file": delete_file,
    "list_dir":    list_dir,
    "make_dir":    make_dir,
    "file_exists": file_exists,
    "file_info":   file_info,
}


def dispatch(workspace_id: str, tool_name: str, params: dict) -> Union[str, list, dict, bool, int]:
    fn = TOOL_REGISTRY.get(tool_name)
    if fn is None:
        raise ValueError(f"unknown file tool: {tool_name!r}")
    return fn(workspace_id, **params)
