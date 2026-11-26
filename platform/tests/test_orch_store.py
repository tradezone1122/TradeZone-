"""Tests for backend/orch_store.py"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_tmp = tempfile.mkdtemp(prefix="up_orch_test_")
os.environ["UP_STORAGE"] = _tmp
import backend.settings as _s
_s.STORAGE = Path(_tmp)

import backend.orch_store as db
db.DB_PATH = Path(_tmp) / "orchestrator.db"


@pytest.fixture(autouse=True)
def fresh_db(tmp_path):
    """Each test gets a fresh DB."""
    import backend.orch_store as _db
    _db.DB_PATH = tmp_path / "test_orch.db"
    # reset thread-local connection
    import threading
    _db._local = threading.local()
    yield
    con = getattr(_db._local, "con", None)
    if con:
        con.close()
    _db._local = threading.local()


# ── Runs ─────────────────────────────────────────────────────────────────────

def test_create_and_get_run():
    run = db.create_run("build a website")
    assert run.id
    assert run.status == "pending"
    assert run.goal == "build a website"

    fetched = db.get_run(run.id)
    assert fetched.id == run.id
    assert fetched.goal == run.goal


def test_get_run_missing_returns_none():
    assert db.get_run("nonexistent") is None


def test_update_run_status():
    run = db.create_run("goal")
    db.update_run_status(run.id, "running")
    assert db.get_run(run.id).status == "running"
    db.update_run_status(run.id, "done")
    fetched = db.get_run(run.id)
    assert fetched.status == "done"
    assert fetched.finished_at is not None


def test_list_runs():
    db.create_run("g1")
    db.create_run("g2")
    runs = db.list_runs()
    assert len(runs) >= 2


# ── Tasks ─────────────────────────────────────────────────────────────────────

def test_create_and_get_task():
    run = db.create_run("goal")
    task = db.create_task(run.id, "write tests", "write unit tests")
    assert task.id
    assert task.name == "write tests"
    assert task.status == "pending"

    fetched = db.get_task(task.id)
    assert fetched.id == task.id
    assert fetched.run_id == run.id


def test_task_dependencies():
    run = db.create_run("g")
    t1 = db.create_task(run.id, "t1")
    t2 = db.create_task(run.id, "t2", depends_on=[t1.id])
    assert t1.id in t2.depends_on


def test_list_tasks():
    run = db.create_run("g")
    db.create_task(run.id, "a")
    db.create_task(run.id, "b")
    tasks = db.list_tasks(run.id)
    assert len(tasks) == 2
    assert {t.name for t in tasks} == {"a", "b"}


def test_update_task_status():
    run = db.create_run("g")
    task = db.create_task(run.id, "t")
    db.update_task(task.id, status="running")
    assert db.get_task(task.id).status == "running"
    db.update_task(task.id, status="done", result="success output")
    fetched = db.get_task(task.id)
    assert fetched.status == "done"
    assert fetched.result == "success output"
    assert fetched.finished_at is not None


def test_update_task_error():
    run = db.create_run("g")
    task = db.create_task(run.id, "t")
    db.update_task(task.id, status="failed", error="something broke")
    fetched = db.get_task(task.id)
    assert fetched.error == "something broke"


# ── Events ────────────────────────────────────────────────────────────────────

def test_add_and_list_events():
    run = db.create_run("g")
    task = db.create_task(run.id, "t")
    db.add_event(task.id, run.id, "task_started", '{"x": 1}')
    db.add_event(task.id, run.id, "task_done",    '{"result": "ok"}')
    events = db.list_events(run.id)
    assert len(events) == 2
    assert events[0].type == "task_started"
    assert events[1].type == "task_done"


def test_events_isolated_per_run():
    run1 = db.create_run("g1")
    run2 = db.create_run("g2")
    t1 = db.create_task(run1.id, "t1")
    t2 = db.create_task(run2.id, "t2")
    db.add_event(t1.id, run1.id, "ev1")
    db.add_event(t2.id, run2.id, "ev2")
    assert len(db.list_events(run1.id)) == 1
    assert len(db.list_events(run2.id)) == 1
