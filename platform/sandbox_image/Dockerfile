# Minimal image for the platform's Docker sandbox backend.
# Idea (containerised execution, non-root user, /workspace) taken from claude-code-sandbox (MIT,
# textcortex); this file is smaller on purpose: no Claude Code CLI, no git/gh, no credentials.
# Build:  docker build -t unified-sandbox:latest sandbox_image/
FROM python:3.13-slim
RUN useradd -m -u 1000 sandbox && mkdir /workspace && chown sandbox /workspace
USER sandbox
WORKDIR /workspace
