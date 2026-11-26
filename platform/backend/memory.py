"""Long-term memory: durable facts saved by agents/users, recalled by keyword match."""
from __future__ import annotations
import re, time
from . import store

def _init():
    store.conn().execute("CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, "
                         "content TEXT NOT NULL, ts REAL NOT NULL)")

def save(content: str, scope: str = "global") -> int:
    content = content.strip()
    if not content or len(content) > 2000:
        raise ValueError("memory must be 1-2000 characters")
    _init()
    with store._lock:
        c = store.conn()
        dup = c.execute("SELECT id FROM memories WHERE scope=? AND content=?", (scope, content)).fetchone()
        if dup:
            return dup["id"]
        cur = c.execute("INSERT INTO memories(scope,content,ts) VALUES(?,?,?)", (scope, content, time.time()))
        c.commit()
        return cur.lastrowid

def recall(query: str, scope: str = "global", k: int = 5) -> list[dict]:
    _init()
    terms = [t.lower() for t in re.findall(r"\w{3,}", query)]
    rows = store.conn().execute("SELECT id, content, ts FROM memories WHERE scope=? ORDER BY id DESC",
                                (scope,)).fetchall()
    scored = []
    for r in rows:
        low = r["content"].lower()
        s = sum(1 for t in terms if t in low)
        if s:
            scored.append((s, r["id"], dict(r)))
    scored.sort(key=lambda x: (-x[0], -x[1]))
    return [x[2] for x in scored[:k]]

def list_all(scope: str = "global") -> list[dict]:
    _init()
    return [dict(r) for r in store.conn().execute("SELECT id, content, ts FROM memories WHERE scope=? ORDER BY id DESC", (scope,))]

def delete(mid: int) -> bool:
    _init()
    with store._lock:
        cur = store.conn().execute("DELETE FROM memories WHERE id=?", (mid,)); store.conn().commit()
        return cur.rowcount > 0
