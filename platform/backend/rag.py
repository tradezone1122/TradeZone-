"""RAG layer built on the vendored knowledge-rag modules (MIT).

Uses knowledge-rag's DocumentParser (parsing + chunking) and Fts5LexicalIndex
(SQLite FTS5 / BM25). Dense embeddings and reranking from the original project
need chromadb/fastembed, which are NOT installed here, so retrieval is lexical only.
"""
from __future__ import annotations
import re, sqlite3, threading
from pathlib import Path
from . import settings

settings.setup_rag_path()
from mcp_server.ingestion import DocumentParser          # noqa: E402
from mcp_server.fts5_index import Fts5LexicalIndex       # noqa: E402

_STOP = set("a an the is are was were be been of to in on at for and or but with by from as it this that what which who how why when where do does did can could should would i you he she we they me my your our their".split())
# The vendored FTS5 tokenizer keeps '.', '-' and '_' inside tokens (so file names match), which
# means "widgets." never matches "widgets". We index a punctuation-trimmed copy of each chunk.
_TRAIL = re.compile(r"([A-Za-z0-9])[.,;:!?)\]]+(?=\s|$)")

def _fts_text(t: str) -> str:
    return _TRAIL.sub(r"\1", t)

def _terms(q: str) -> list[str]:
    ws = re.findall(r"[A-Za-z0-9_\u0600-\u06FF][A-Za-z0-9_.\-\u0600-\u06FF]*", q)
    out = []
    for w in ws:
        w = w.rstrip(".-_")
        if len(w) > 1 and w.lower() not in _STOP and w not in out:
            out.append(w)
    return out

class Rag:
    def __init__(self, base: Path | None = None):
        base = Path(base or settings.STORAGE / "rag")
        base.mkdir(parents=True, exist_ok=True)
        self.index = Fts5LexicalIndex(base / "fts5.db", base / "fts5_state.json")
        self._chunks = sqlite3.connect(base / "chunks.db", check_same_thread=False)
        self._chunks.execute("CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, filename TEXT, content TEXT)")
        self._lock = threading.Lock()
        self.parser = DocumentParser()

    def ingest(self, path: Path, logical_name: str | None = None) -> int:
        doc = self.parser.parse_file(Path(path), logical_filename=logical_name)
        if doc is None:
            raise ValueError(f"unsupported or empty document: {Path(path).name}")
        name = logical_name or doc.filename
        n = 0
        with self._lock:
            for i, ch in enumerate(doc.chunks):
                cid = f"{doc.id}:{i}"
                self.index.add_document(cid, _fts_text(ch.content), name, doc.category)
                self._chunks.execute("INSERT OR REPLACE INTO chunks VALUES(?,?,?)", (cid, name, ch.content))
                n += 1
            self._chunks.commit()
        return n

    def search(self, query: str, top_k: int = 4) -> list[dict]:
        # OR-style retrieval: the vendored search ANDs every token, which fails for
        # natural-language questions. Run each term, rank by terms matched then BM25.
        agg: dict[str, list] = {}
        for term in _terms(query):
            for cid, sc in self.index.search(term, top_k=top_k * 5):
                a = agg.setdefault(cid, [0, 0.0]); a[0] += 1; a[1] += sc
        hits = [(cid, v[0] + v[1] / 1000.0) for cid, v in sorted(agg.items(), key=lambda kv: (-kv[1][0], -kv[1][1]))][:top_k]
        out = []
        for cid, score in hits:
            row = self._chunks.execute("SELECT filename, content FROM chunks WHERE id=?", (cid,)).fetchone()
            if row:
                out.append({"id": cid, "filename": row[0], "content": row[1], "score": round(score, 4)})
        return out

    def count(self) -> int:
        return self.index.count()
