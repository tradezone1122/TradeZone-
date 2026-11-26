# Merge report
| Component | Versions found | Selected | Reason |
|---|---|---|---|
| Chat UI | splaude chat.html (self-contained, no build); chat-with-gpt (React); claude-ui (Nuxt) | splaude chat.html | only one that runs without npm install |
| RAG | knowledge-rag | knowledge-rag | only RAG codebase in the licensed set |
| Agents / orchestration | open-multi-agent (TS) | new Python runtime (backend/agents.py), same concepts, no code ported | npm deps cannot be installed offline, so the original could not be built or tested |
| Artifact viewer | artifact-viewer-template (Vite) | none merged; replaced by a small sandboxed-iframe viewer I wrote | template needs a build |
| Model layer | kimi-k3-* (torch/C), Splaude engine (Metal) | none; generic OpenAI-compatible router instead | none runnable here (no torch, no GPU/Metal) |
| Sandbox | claude-code-sandbox (MIT, TypeScript, runs the Claude Code CLI in Docker with bridge network) | own runner with two backends: local (guard rail) and docker (stricter than the original: no network, read-only rootfs, caps dropped, non-root, limits). Only the idea was reused | original needs npm + the proprietary CLI and was not built |
Conflicts: none, because only two projects were merged. Originals are untouched in the extracted `originals/` copy and the uploaded zips.
