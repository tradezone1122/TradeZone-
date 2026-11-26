# Project state
Docker sandbox backend added (fake-docker tested; 40/40 tests).
Last completed: chat+RAG+artifacts+tools+agents+memory+panel, 34/34 tests passing against a mock upstream.
Not done: MCP client, separate planner, dense retrieval, real-sandbox, UI integration of artifacts/skills/RAG sources.
Next steps once network or a package mirror is available: `npm ci` in open-multi-agent and add a Node worker behind /api/agents; `pip install chromadb fastembed` to enable the original hybrid search; build artifact-viewer-template.
Open decision: GPL/AGPL projects and the claude-code sources were excluded (see LICENSE_NOTES.md).
