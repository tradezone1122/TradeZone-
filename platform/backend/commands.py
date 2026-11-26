"""
Independent Python implementation of a Claude Code-style slash command system.
Built from architecture patterns in official documentation — no Anthropic code copied.

Command interface:
  name        str
  description str
  execute(args: str, context: CommandContext) -> str

Usage:
    registry = CommandRegistry()
    result = registry.run("/help", context)
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class CommandContext:
    """Runtime context available to all commands."""
    cwd: str = "."
    config_path: str = "config/platform.json"
    history: list[dict] = field(default_factory=list)
    model: str = "default"
    extra: dict = field(default_factory=dict)

    def load_config(self) -> dict:
        p = Path(self.config_path)
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:
                return {}
        return {}

    def save_config(self, cfg: dict) -> None:
        p = Path(self.config_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(cfg, indent=2))


@dataclass
class Command:
    name: str
    description: str
    execute: Callable[[str, CommandContext], str]
    usage: str = ""


class CommandRegistry:
    def __init__(self):
        self._commands: dict[str, Command] = {}

    def register(self, cmd: Command) -> None:
        self._commands[cmd.name] = cmd

    def get(self, name: str) -> Command | None:
        return self._commands.get(name.lstrip("/"))

    def run(self, raw: str, context: CommandContext) -> str:
        """Parse '/name args...' and execute."""
        parts = raw.strip().split(None, 1)
        if not parts:
            return "(empty command)"
        name = parts[0].lstrip("/")
        args = parts[1] if len(parts) > 1 else ""
        cmd = self._commands.get(name)
        if cmd is None:
            return f"Unknown command: /{name}  (type /help for available commands)"
        try:
            return cmd.execute(args, context)
        except Exception as exc:
            return f"Command error: {exc}"

    def all_commands(self) -> list[Command]:
        return sorted(self._commands.values(), key=lambda c: c.name)


# ── Built-in commands ─────────────────────────────────────────────────────────

def _cmd_help(args: str, ctx: CommandContext) -> str:
    reg = _get_registry()
    lines = ["Available commands:\n"]
    for cmd in reg.all_commands():
        usage = f"  Usage: {cmd.usage}" if cmd.usage else ""
        lines.append(f"  /{cmd.name:<18} {cmd.description}{usage}")
    return "\n".join(lines)


def _cmd_config(args: str, ctx: CommandContext) -> str:
    cfg = ctx.load_config()
    if not args.strip():
        return json.dumps(cfg, indent=2) if cfg else "(no config found)"

    parts = args.split(None, 2)
    if len(parts) == 1 and parts[0] == "list":
        return json.dumps(cfg, indent=2) if cfg else "(empty)"

    if len(parts) >= 2:
        action = parts[0]
        key    = parts[1]
        value  = parts[2] if len(parts) > 2 else None

        if action == "get":
            obj = cfg
            for k in key.split("."):
                if isinstance(obj, dict):
                    obj = obj.get(k, "(not found)")
                elif isinstance(obj, list):
                    try:
                        obj = obj[int(k)]
                    except (IndexError, ValueError):
                        obj = "(not found)"
            return str(obj)

        if action == "set" and value is not None:
            try:
                cfg[key] = json.loads(value)
            except json.JSONDecodeError:
                cfg[key] = value
            ctx.save_config(cfg)
            return f"Set {key} = {value}"

    return "Usage: /config [list] | /config get <key> | /config set <key> <value>"


def _cmd_init(args: str, ctx: CommandContext) -> str:
    cwd = Path(ctx.cwd)
    cfg_path = cwd / "CLAUDE.md"

    if cfg_path.exists():
        return f"CLAUDE.md already exists at {cfg_path}"

    content = """# Project Configuration

## Overview
Describe your project here.

## Development Commands
```bash
# Install dependencies

# Run tests

# Start server
```

## Architecture Notes
-

## Key Files
-

## Conventions
-
"""
    cfg_path.write_text(content)
    return f"Created {cfg_path}"


def _cmd_commit(args: str, ctx: CommandContext) -> str:
    cwd = ctx.cwd

    stage = subprocess.run(
        ["git", "add", "-A"], cwd=cwd, capture_output=True, text=True
    )
    if stage.returncode != 0:
        return f"git add failed: {stage.stderr}"

    diff = subprocess.run(
        ["git", "diff", "--cached", "--stat"], cwd=cwd, capture_output=True, text=True
    )
    diff_text = diff.stdout.strip()

    if not diff_text:
        return "Nothing staged to commit."

    msg = args.strip() or "Update files"

    commit = subprocess.run(
        ["git", "commit", "-m", msg],
        cwd=cwd, capture_output=True, text=True
    )
    if commit.returncode != 0:
        return f"git commit failed: {commit.stderr}"
    return commit.stdout.strip()


def _cmd_review(args: str, ctx: CommandContext) -> str:
    cwd = ctx.cwd
    base = args.strip() or "HEAD~1"

    diff = subprocess.run(
        ["git", "diff", base, "--stat"],
        cwd=cwd, capture_output=True, text=True
    )
    full_diff = subprocess.run(
        ["git", "diff", base],
        cwd=cwd, capture_output=True, text=True
    )
    if diff.returncode != 0:
        return f"git diff failed: {diff.stderr}"

    return f"=== Diff stat ({base} → HEAD) ===\n{diff.stdout}\n\n=== Full diff ===\n{full_diff.stdout[:4000]}"


def _cmd_status(args: str, ctx: CommandContext) -> str:
    cwd = ctx.cwd
    result = subprocess.run(
        ["git", "status", "--short", "--branch"],
        cwd=cwd, capture_output=True, text=True
    )
    if result.returncode != 0:
        return f"Not a git repo or git error: {result.stderr}"
    return result.stdout.strip() or "(clean)"


def _cmd_clear(args: str, ctx: CommandContext) -> str:
    ctx.history.clear()
    return "(conversation history cleared)"


def _cmd_model(args: str, ctx: CommandContext) -> str:
    if not args.strip():
        return f"Current model: {ctx.model}"
    cfg = ctx.load_config()
    cfg["default_model"] = args.strip()
    ctx.save_config(cfg)
    ctx.model = args.strip()
    return f"Model set to: {ctx.model}"


def _cmd_history(args: str, ctx: CommandContext) -> str:
    if not ctx.history:
        return "(no history)"
    lines = []
    for i, msg in enumerate(ctx.history[-20:], 1):
        role = msg.get("role", "?")
        content = str(msg.get("content", ""))[:120]
        lines.append(f"{i:3}. [{role}] {content}")
    return "\n".join(lines)


def _cmd_tools(args: str, ctx: CommandContext) -> str:
    try:
        from .tool_registry import build_default_registry
        reg = build_default_registry()
        tools = reg.list_tools()
        lines = [f"Available tools ({len(tools)}):"]
        for t in tools:
            fn = t["function"]
            lines.append(f"  {fn['name']:<22} {fn['description'][:60]}")
        return "\n".join(lines)
    except Exception as exc:
        return f"Could not load tool registry: {exc}"


def _cmd_agents(args: str, ctx: CommandContext) -> str:
    try:
        from .multi_agent_api import get_pool
        pool = get_pool()
        agents = pool.list_agents()
        lines = [f"Agent pool ({len(agents)} agents):"]
        for ag in agents:
            tools = ", ".join(ag.get("tools", []))
            lines.append(f"  {ag['name']:<18} tools: {tools or '(none)'}")
        return "\n".join(lines)
    except Exception as exc:
        return f"Could not load agent pool: {exc}"


def _cmd_run_agent(args: str, ctx: CommandContext) -> str:
    parts = args.split(None, 1)
    if len(parts) < 2:
        return "Usage: /agent <name> <task>"
    name, task = parts[0], parts[1]
    try:
        from .multi_agent_api import get_pool
        return get_pool().run(name, task)
    except Exception as exc:
        return f"Agent error: {exc}"


def _cmd_exit(args: str, ctx: CommandContext) -> str:
    raise SystemExit(0)


# ── Singleton registry ────────────────────────────────────────────────────────

_registry: CommandRegistry | None = None


def _get_registry() -> CommandRegistry:
    global _registry
    if _registry is None:
        _registry = build_default_registry()
    return _registry


def build_default_registry() -> CommandRegistry:
    """Return a CommandRegistry with all built-in commands registered."""
    reg = CommandRegistry()
    cmds = [
        Command("help",    "Show all available commands",                       _cmd_help),
        Command("config",  "View or edit platform config",                      _cmd_config,  "Usage: /config [list|get <key>|set <key> <val>]"),
        Command("init",    "Create CLAUDE.md project config file",              _cmd_init),
        Command("commit",  "Stage all and git commit",                          _cmd_commit,  "Usage: /commit [message]"),
        Command("review",  "Show git diff for review",                          _cmd_review,  "Usage: /review [base-ref]"),
        Command("status",  "Show git status",                                   _cmd_status),
        Command("clear",   "Clear conversation history",                        _cmd_clear),
        Command("model",   "Show or change the active model",                   _cmd_model,   "Usage: /model [model-name]"),
        Command("history", "Show recent conversation history",                  _cmd_history),
        Command("tools",   "List all available tools",                          _cmd_tools),
        Command("agents",  "List all agents in the pool",                       _cmd_agents),
        Command("agent",   "Run a task on a named agent",                       _cmd_run_agent, "Usage: /agent <name> <task>"),
        Command("exit",    "Exit the CLI",                                      _cmd_exit),
        Command("quit",    "Exit the CLI",                                      _cmd_exit),
    ]
    for cmd in cmds:
        reg.register(cmd)
    return reg
