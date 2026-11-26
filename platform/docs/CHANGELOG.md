# Changelog (changes to original files)
- frontend/index.html: copied from splaude `server/chat.html` (Apache-2.0). Modified: one `<a href="/panel">` link appended at the end of the file.
- vendor/knowledge_rag/: copied unmodified from knowledge-rag `mcp_server/` and `skills/` (MIT).
- Workarounds for vendored behaviour are in `backend/rag.py` (not in vendor): the FTS5 tokenizer keeps trailing '.' in tokens and the search ANDs all terms, so indexing uses a punctuation-trimmed copy and queries run per term.
- backend/sandbox.py: added docker backend; sandbox_image/Dockerfile written for it (inspired by claude-code-sandbox, MIT; no code copied).
- Everything else is new glue code.
