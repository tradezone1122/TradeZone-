# Known limitations
| Capability | Status |
|---|---|
| Streaming responses, conversation log, session memory (SQLite) | INTEGRATED, tested with mock upstream |
| RAG (parse, chunk, FTS5/BM25) | INTEGRATED, lexical only. No embeddings, vector search or reranker (need chromadb/fastembed, not installable here) |
| File upload and processing | INTEGRATED for formats the vendored parser reads (md, txt, pdf via pymupdf if installed, code, json, docx/xlsx if libs installed) |
| Skills | PARTIAL: indexed and listed/readable; nothing auto-selects or executes them |
| Tool execution / code execution | PARTIAL: allowlisted command runner, off by default. Backend `local` is NOT a secure sandbox. Backend `docker` (config `sandbox.backend`) builds a locked-down `docker run` command and never falls back to local, but was tested only with a FAKE docker binary: no Docker daemon exists here, so real isolation and the image build (sandbox_image/Dockerfile) are UNVERIFIED. Allowlist is argv-only (no shell), so `python3 -c` can still run arbitrary code inside the container |
| Artifacts + viewer | PARTIAL: store, versions, CSP-sandboxed iframe viewer. The chat UI does not create artifacts automatically |
| Model providers / routing | PARTIAL: OpenAI-compatible upstreams only; no Anthropic-native or Bedrock/Gemini; no fallback/retry |
| Agents, tool-calling loop, delegation (lead -> specialists), bounded steps/depth | INTEGRATED, tested with a scripted mock model only; quality with real models untested. Tool calling needs an upstream that supports OpenAI `tools` |
| Task planning | PARTIAL: only what the lead agent's prompt does via delegation; no separate planner/workflow engine |
| MCP client | MISSING (knowledge-rag is an MCP *server*; open-multi-agent has an MCP client but could not be built offline) |
| Long-term memory | INTEGRATED: keyword recall over SQLite, saved by agents or via /api/memory; no semantic recall |
| Image generation, document generation | MISSING |
| Auth / multi-user | MISSING: binds to 127.0.0.1, no user accounts; tools use a startup token |
| Logging/monitoring | MINIMAL: /health only |
| Frontend | Chat page keeps chats in browser localStorage and does not show RAG sources inline. A separate /panel page shows agents + tool activity, knowledge upload/search, memory, artifacts, skills, sessions |
| Terminal UI, project workspace, plugins | MISSING |
Agents do not run from the chat page; they run from /panel or /api/agent/run.
Not claimed: that this "matches Claude". It is a small chat+RAG gateway.
