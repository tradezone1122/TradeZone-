"""SQLite persistence: conversation log (session memory) and versioned artifacts."""
from __future__ import annotations
import sqlite3, threading, time, uuid
from .settings import STORAGE

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        STORAGE.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(STORAGE / "platform.db", check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript("""
        CREATE TABLE IF NOT EXISTS messages(
          id INTEGER PRIMARY KEY, session TEXT NOT NULL, role TEXT NOT NULL,
          content TEXT NOT NULL, model TEXT, ts REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS m_sess ON messages(session, id);
        CREATE TABLE IF NOT EXISTS artifacts(
          id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL,
          kind TEXT NOT NULL, content TEXT NOT NULL, ts REAL NOT NULL,
          PRIMARY KEY(id, version));
        """)
    return _conn

def reset_for_tests() -> None:
    global _conn
    if _conn is not None:
        _conn.close()
    _conn = None

def add_message(session: str, role: str, content: str, model: str | None = None) -> None:
    with _lock:
        conn().execute("INSERT INTO messages(session,role,content,model,ts) VALUES(?,?,?,?,?)",
                       (session, role, content, model, time.time()))
        conn().commit()

def history(session: str, limit: int = 50) -> list[dict]:
    rows = conn().execute("SELECT role,content,model,ts FROM messages WHERE session=? "
                          "ORDER BY id DESC LIMIT ?", (session, limit)).fetchall()
    return [dict(r) for r in reversed(rows)]

def sessions() -> list[dict]:
    rows = conn().execute("SELECT session, COUNT(*) n, MAX(ts) last FROM messages "
                          "GROUP BY session ORDER BY last DESC").fetchall()
    return [dict(r) for r in rows]

ARTIFACT_KINDS = {"html", "svg", "markdown", "text", "code"}

def save_artifact(title: str, kind: str, content: str, artifact_id: str | None = None) -> dict:
    if kind not in ARTIFACT_KINDS:
        raise ValueError(f"kind must be one of {sorted(ARTIFACT_KINDS)}")
    with _lock:
        c = conn()
        if artifact_id:
            row = c.execute("SELECT MAX(version) v FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
            if row["v"] is None:
                raise KeyError(artifact_id)
            version = row["v"] + 1
        else:
            artifact_id, version = uuid.uuid4().hex[:12], 1
        c.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?)",
                  (artifact_id, version, title, kind, content, time.time()))
        c.commit()
    return {"id": artifact_id, "version": version, "title": title, "kind": kind}

def get_artifact(artifact_id: str, version: int | None = None) -> dict | None:
    c = conn()
    if version is None:
        r = c.execute("SELECT * FROM artifacts WHERE id=? ORDER BY version DESC LIMIT 1", (artifact_id,)).fetchone()
    else:
        r = c.execute("SELECT * FROM artifacts WHERE id=? AND version=?", (artifact_id, version)).fetchone()
    return dict(r) if r else None

def list_artifacts() -> list[dict]:
    rows = conn().execute("SELECT id, MAX(version) version, title, kind, MAX(ts) ts FROM artifacts "
                          "GROUP BY id ORDER BY ts DESC").fetchall()
    return [dict(r) for r in rows]
