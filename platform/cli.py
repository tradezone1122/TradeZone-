"""
AI Platform CLI — interactive REPL powered by any OpenAI-compatible model.
Supports slash commands (/help, /commit, /review, ...) and tool calls.

Usage:
    python cli.py                          # interactive REPL
    python cli.py "What is 2+2?"          # single query
    python cli.py --model kimi/moonshot-v1-8k "explain this code"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from backend.settings import load as load_settings
from backend.router import Router
from backend.tool_registry import build_default_registry
from backend.query_engine import QueryEngine, QueryConfig
from backend.context_manager import ContextManager
from backend.commands import build_default_registry as build_commands, CommandContext


BANNER = """
╔══════════════════════════════════════════════════════╗
║          AI Platform — Powered by Kimi K3 Pro        ║
║  Type /help for commands. Ctrl+C or /exit to quit.   ║
╚══════════════════════════════════════════════════════╝
"""


def build_engine(cfg: dict, model: str | None = None) -> QueryEngine:
    router = Router(cfg)
    tools  = build_default_registry()
    ctxmgr = ContextManager(".")
    system_prompt = ctxmgr.build_system_prompt()

    qcfg = QueryConfig(
        max_turns=10,
        max_retries=3,
        max_tokens=int(cfg.get("max_tokens", 4096)),
        temperature=float(cfg.get("temperature", 0.7)),
        stream=True,
    )

    if model:
        original_chat = router.chat
        original_stream_chat = router.stream_chat

        def _chat(payload):
            return original_chat({**payload, "model": model})

        def _stream_chat(payload):
            yield from original_stream_chat({**payload, "model": model})

        router.chat = _chat
        router.stream_chat = _stream_chat

    return QueryEngine(
        router=router,
        tool_registry=tools,
        system_prompt=system_prompt,
        config=qcfg,
        on_text=lambda t: None,
        on_tool_call=lambda n, a: print(f"\n  [tool] {n}({json.dumps(a)[:60]}...)\n", end=""),
    )


def run_repl(engine: QueryEngine, cfg: dict) -> None:
    history: list[dict] = []
    cmd_ctx = CommandContext(cwd=".", config_path="config/platform.json", history=history,
                             model=cfg.get("default_model", "default"))
    cmd_reg = build_commands()

    print(BANNER)

    while True:
        try:
            user_input = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye.")
            break

        if not user_input:
            continue

        if user_input.startswith("/"):
            result = cmd_reg.run(user_input, cmd_ctx)
            print(f"  {result}\n")
            continue

        history.append({"role": "user", "content": user_input})
        print("ai> ", end="", flush=True)
        try:
            full_text = []
            for chunk in engine.stream(user_input, history[:-1]):
                print(chunk, end="", flush=True)
                full_text.append(chunk)
            print()
            history.append({"role": "assistant", "content": "".join(full_text)})
        except Exception as exc:
            print(f"\n[error] {exc}")


def run_single(engine: QueryEngine, query: str) -> None:
    for chunk in engine.stream(query):
        print(chunk, end="", flush=True)
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Platform CLI")
    parser.add_argument("query", nargs="?", help="Single query (non-interactive)")
    parser.add_argument("--model", help="Model override, e.g. kimi/moonshot-v1-8k")
    parser.add_argument("--config", default="config/platform.json", help="Config file path")
    args = parser.parse_args()

    if Path(args.config).exists():
        try:
            cfg = json.loads(Path(args.config).read_text())
        except Exception:
            cfg = {}
    else:
        cfg = load_settings()

    engine = build_engine(cfg, model=args.model)

    if args.query:
        run_single(engine, args.query)
    else:
        run_repl(engine, cfg)


if __name__ == "__main__":
    main()
