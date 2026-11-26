# Architecture map (as built)
```
Browser: frontend/index.html (from splaude server/chat.html, Apache-2.0)
   |  GET /v1/models, POST /v1/chat/completions (SSE)
backend/app.py (Starlette)
   |- RAG injection  -> backend/rag.py -> vendor/knowledge_rag/mcp_server/{ingestion.py (DocumentParser), fts5_index.py (Fts5LexicalIndex)}
   |- Routing        -> backend/router.py -> any OpenAI-compatible upstream (config/platform.json)
   |- Session log    -> backend/store.py (SQLite messages)
   |- /api/upload    -> save + RAG ingest
   |- /api/skills    -> backend/skills.py scans vendor/knowledge_rag/skills/**/SKILL.md
   |- /api/tools/run -> backend/sandbox.py (allowlist, rlimits, timeout; NOT a real sandbox), needs UP_TOOLS=1 + X-Admin-Token
   |- /api/agent/run -> backend/agents.py (tool loop; tools: rag_search, memory_*, skill_read, artifact_create, shell, delegate) -> router
   |- /api/memory   -> backend/memory.py (SQLite)
   |- /panel        -> frontend/panel.html (new): agents, knowledge, memory, artifacts, skills, sessions
   |- /api/artifacts, /artifacts/{id} -> backend/store.py (versioned) + iframe viewer with CSP sandbox
```
Request path: User -> chat UI -> /v1/chat/completions -> session log -> RAG context -> router -> upstream -> SSE stream -> UI. The chat path has no agent loop; agents are a separate entry point (/api/agent/run). Agent selection is by name, chosen by the caller.
New files (glue, written by me): everything in `backend/`, `run.py`, `tests/`, `config/`, `docs/`. Original code: `vendor/knowledge_rag/`, `frontend/`.
