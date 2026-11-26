"""
Orchestrator Store — P2
SQLite tables: runs, tasks, task_events.
Keeps orchestrator state durable across restarts.
"""
from __future__ import annotations

import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from . import settings

DB_PATH = settings.STORAGE / "orchestrator.db"

_DDL = """
CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending',
    goal        TEXT NOT NULL DEFAULT '',
    model       TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    finished_at REAL
);

CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    depends_on  TEXT NOT NULL DEFAULT '',
    workspace_id TEXT,
    result      TEXT,
    error       TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    finished_at REAL
);

CREATE INDEX IF NOT EXISTS tasks_run_id ON tasks(run_id);

CREATE TABLE IF NOT EXISTS task_events (
    id        TEXT PRIMARY KEY,
    task_id   TEXT NOT NULL REFERENCES tasks(id),
    run_id    TEXT NOT NULL,
    type      TEXT NOT NULL,
    payload   TEXT NOT NULL DEFAULT '{}',
    ts        REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS tevents_run_id ON task_events(run_id);
CREATE INDEX IF NOT EXISTS tevents_task_id ON task_events(task_id);
"""


# ── Domain types ─────────────────────────────────────────────────────────────

@dataclass
class Run:
    id: str
    goal: str
    status: str = "pending"       # pending | running | done | failed
    model: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None


@dataclass
class Task:
    id: str
    run_id: str
    name: str
    description: str = ""
    status: str = "pending"       # pending | running | done | failed | skipped
    depends_on: str = ""          # comma-separated task IDs
    workspace_id: Optional[str] = None
    result: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None


@dataclass
class TaskEvent:
    id: str
    task_id: str
    run_id: str
    type: str
    payload: str = "{}"
    ts: float = field(default_factory=time.time)


# ── Connection pool (thread-local) ───────────────────────────────────────────

_local = threading.local()


def _conn() -> sqlite3.Connection:
    con = getattr(_local, "con", None)
    if con is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        con.executescript(_DDL)
        con.commit()
        _local.con = con
    return con


@contextmanager
def _tx():
    con = _conn()
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise


# ── Run CRUD ─────────────────────────────────────────────────────────────────

def create_run(goal: str, model: Optional[str] = None) -> Run:
    run = Run(id=uuid.uuid4().hex, goal=goal, model=model)
    with _tx() as con:
        con.execute(
            "INSERT INTO runs VALUES (?,?,?,?,?,?,?)",
            (run.id, run.status, run.goal, run.model,
             run.created_at, run.updated_at, run.finished_at),
        )
    return run


def get_run(run_id: str) -> Optional[Run]:
    row = _conn().execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if not row:
        return None
    return Run(**dict(row))


def update_run_status(run_id: str, status: str) -> None:
    now = time.time()
    finished = now if status in ("done", "failed") else None
    with _tx() as con:
        con.execute(
            "UPDATE runs SET status=?, updated_at=?, finished_at=? WHERE id=?",
            (status, now, finished, run_id),
        )


def list_runs(limit: int = 50) -> list[Run]:
    rows = _conn().execute(
        "SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return [Run(**dict(r)) for r in rows]


# ── Task CRUD ─────────────────────────────────────────────────────────────────

def create_task(run_id: str, name: str, description: str = "",
                depends_on: list[str] | None = None) -> Task:
    task = Task(
        id=uuid.uuid4().hex, run_id=run_id, name=name,
        description=description,
        depends_on=",".join(depends_on or []),
    )
    with _tx() as con:
        con.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (task.id, task.run_id, task.name, task.description,
             task.status, task.depends_on, task.workspace_id,
             task.result, task.error,
             task.created_at, task.updated_at, task.finished_at),
        )
    return task


def get_task(task_id: str) -> Optional[Task]:
    row = _conn().execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        return None
    return Task(**dict(row))


def list_tasks(run_id: str) -> list[Task]:
    rows = _conn().execute(
        "SELECT * FROM tasks WHERE run_id=? ORDER BY created_at", (run_id,)
    ).fetchall()
    return [Task(**dict(r)) for r in rows]


def update_task(task_id: str, **kwargs) -> None:
    kwargs["updated_at"] = time.time()
    if kwargs.get("status") in ("done", "failed", "skipped"):
        kwargs.setdefault("finished_at", time.time())
    sets = ", ".join(f"{k}=?" for k in kwargs)
    vals = list(kwargs.values()) + [task_id]
    with _tx() as con:
        con.execute(f"UPDATE tasks SET {sets} WHERE id=?", vals)


# ── Task events ───────────────────────────────────────────────────────────────

def add_event(task_id: str, run_id: str, event_type: str, payload: str = "{}") -> TaskEvent:
    ev = TaskEvent(
        id=uuid.uuid4().hex, task_id=task_id, run_id=run_id,
        type=event_type, payload=payload,
    )
    with _tx() as con:
        con.execute(
            "INSERT INTO task_events VALUES (?,?,?,?,?,?)",
            (ev.id, ev.task_id, ev.run_id, ev.type, ev.payload, ev.ts),
        )
    return ev


def list_events(run_id: str, limit: int = 200) -> list[TaskEvent]:
    rows = _conn().execute(
        "SELECT * FROM task_events WHERE run_id=? ORDER BY ts LIMIT ?",
        (run_id, limit),
    ).fetchall()
    return [TaskEvent(**dict(r)) for r in rows]
