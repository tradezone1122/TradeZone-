"""
Independent Python implementation of a Claude Code-style context/system-prompt builder.
Collects OS, shell, git, project memory, and constructs the system prompt.
No Anthropic dependency.

Usage:
    ctx = ContextManager(".")
    system_prompt = ctx.build_system_prompt()
"""
from __future__ import annotations

import os
import platform
import subprocess
from pathlib import Path


class ContextManager:
    """Collects runtime context and builds the system prompt."""

    def __init__(self, cwd: str = "."):
        self.cwd = Path(cwd).resolve()

    # ── Public API ─────────────────────────────────────────────────────────────

    def build_system_prompt(
        self,
        base_instructions: str | None = None,
        extra_context: str | None = None,
    ) -> str:
        parts = []

        parts.append(base_instructions or self._default_instructions())

        ctx = self.gather_context()
        if ctx:
            parts.append(f"\n<environment>\n{ctx}\n</environment>")

        memory = self.gather_memory()
        if memory:
            parts.append(f"\n<memory>\n{memory}\n</memory>")

        if extra_context:
            parts.append(f"\n{extra_context}")

        return "\n".join(parts)

    def gather_context(self) -> str:
        lines = []
        lines.append(f"Working directory: {self.cwd}")
        lines.append(f"OS: {platform.system()} {platform.release()}")
        lines.append(f"Python: {platform.python_version()}")

        shell = os.environ.get("SHELL", "unknown")
        lines.append(f"Shell: {shell}")

        git_ctx = self._git_context()
        if git_ctx:
            lines.extend(git_ctx)

        if os.environ.get("CI"):
            lines.append("Running in CI environment")
        if os.environ.get("CONTAINER") or os.path.exists("/.dockerenv"):
            lines.append("Running inside a container")

        return "\n".join(lines)

    def gather_memory(self) -> str:
        """Read CLAUDE.md / .claude.md from project root and parent dirs."""
        memory_parts = []
        search_dirs = [self.cwd] + list(self.cwd.parents)[:3]

        seen = set()
        for d in search_dirs:
            for name in ("CLAUDE.md", ".claude.md", ".claude/CLAUDE.md"):
                p = d / name
                if p in seen or not p.is_file():
                    continue
                seen.add(p)
                try:
                    content = p.read_text(encoding="utf-8", errors="replace").strip()
                    if content:
                        memory_parts.append(f"# From {p.relative_to(self.cwd) if p.is_relative_to(self.cwd) else p}\n{content}")
                except Exception:
                    pass

        return "\n\n---\n\n".join(memory_parts)

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _git_context(self) -> list[str]:
        lines = []
        try:
            branch = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=self.cwd, capture_output=True, text=True, timeout=3
            )
            if branch.returncode == 0:
                lines.append(f"Git branch: {branch.stdout.strip()}")

            status = subprocess.run(
                ["git", "status", "--short"],
                cwd=self.cwd, capture_output=True, text=True, timeout=3
            )
            if status.returncode == 0:
                s = status.stdout.strip()
                if s:
                    changed = len(s.splitlines())
                    lines.append(f"Git status: {changed} changed file(s)")
                else:
                    lines.append("Git status: clean")

            log_out = subprocess.run(
                ["git", "log", "--oneline", "-3"],
                cwd=self.cwd, capture_output=True, text=True, timeout=3
            )
            if log_out.returncode == 0 and log_out.stdout.strip():
                lines.append(f"Recent commits:\n  " + log_out.stdout.strip().replace("\n", "\n  "))
        except Exception:
            pass
        return lines

    @staticmethod
    def _default_instructions() -> str:
        return (
            "You are a highly capable AI coding assistant. "
            "You help with software development tasks: writing code, debugging, "
            "explaining concepts, reviewing changes, and running shell commands. "
            "Be concise, accurate, and practical. "
            "When using tools, prefer the most targeted tool for the job. "
            "Always explain what you are doing and why."
        )
