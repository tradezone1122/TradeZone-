"""
Independent Python implementation of a Claude Code-style QueryEngine.
Core LLM call loop: streaming, tool execution, retries, context management.
Works with ANY OpenAI-compatible API (Kimi K3 Pro, Ollama, local models).
Zero Claude/Anthropic dependency.

Architecture:
  QueryEngine.query(messages)
    → build request (system prompt + messages + tools)
    → POST /v1/chat/completions
    → process response:
        text   → stream to callback
        tool_use → execute tool → append result → continue loop
        stop   → return final text
    → retry on 429/500/502/503

Usage:
    engine = QueryEngine(router)
    for chunk in engine.stream("What is 2+2?"):
        print(chunk, end="", flush=True)
"""
from __future__ import annotations

import json
import time
import logging
from dataclasses import dataclass, field
from typing import Generator, Callable, Any

log = logging.getLogger("query_engine")


@dataclass
class QueryConfig:
    max_turns: int = 10
    max_retries: int = 3
    retry_base: float = 1.5
    max_tokens: int = 4096
    temperature: float = 0.7
    stream: bool = True


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class UsageStats:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    tool_calls: int = 0
    turns: int = 0


class QueryEngine:
    """
    Core LLM call loop. Model-agnostic: works with any OpenAI-compatible router.
    Tool execution is handled via an optional ToolRegistry.
    """

    def __init__(
        self,
        router,
        tool_registry=None,
        system_prompt: str | None = None,
        config: QueryConfig | None = None,
        on_text: Callable[[str], None] | None = None,
        on_tool_call: Callable[[str, dict], None] | None = None,
    ):
        self.router = router
        self.tools = tool_registry
        self.system_prompt = system_prompt
        self.cfg = config or QueryConfig()
        self.on_text = on_text or (lambda t: None)
        self.on_tool_call = on_tool_call or (lambda n, a: None)
        self.usage = UsageStats()

    # ── Public API ─────────────────────────────────────────────────────────────

    def query(self, user_input: str, history: list[dict] | None = None) -> str:
        """Single-shot query. Returns final assistant text."""
        messages = list(history or [])
        messages.append({"role": "user", "content": user_input})
        return self._run_loop(messages)

    def stream(self, user_input: str, history: list[dict] | None = None) -> Generator[str, None, None]:
        """Streaming query. Yields text chunks as they arrive."""
        messages = list(history or [])
        messages.append({"role": "user", "content": user_input})
        yield from self._run_loop_streaming(messages)

    def reset_usage(self) -> None:
        self.usage = UsageStats()

    # ── Core loop (non-streaming) ──────────────────────────────────────────────

    def _run_loop(self, messages: list[dict]) -> str:
        all_text = []
        for turn in range(self.cfg.max_turns):
            self.usage.turns += 1
            response = self._call_api(messages)
            choice = response["choices"][0]
            msg = choice["message"]

            usage = response.get("usage", {})
            self.usage.prompt_tokens     += usage.get("prompt_tokens", 0)
            self.usage.completion_tokens += usage.get("completion_tokens", 0)
            self.usage.total_tokens      += usage.get("total_tokens", 0)

            text = msg.get("content") or ""
            if text:
                all_text.append(text)
                self.on_text(text)

            tool_calls = msg.get("tool_calls", [])
            if not tool_calls:
                break

            messages.append(msg)

            for tc in tool_calls:
                self.usage.tool_calls += 1
                name     = tc["function"]["name"]
                args_str = tc["function"].get("arguments", "{}")
                try:
                    args = json.loads(args_str)
                except json.JSONDecodeError:
                    args = {}
                self.on_tool_call(name, args)
                result = self._execute_tool(name, args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "name": name,
                    "content": result,
                })

            if choice.get("finish_reason") == "stop":
                break

        return "\n".join(all_text)

    # ── Core loop (streaming) ─────────────────────────────────────────────────

    def _run_loop_streaming(self, messages: list[dict]) -> Generator[str, None, None]:
        for turn in range(self.cfg.max_turns):
            self.usage.turns += 1
            tool_calls_acc: dict[int, dict] = {}
            full_text = []

            for chunk in self._call_api_streaming(messages):
                delta = chunk["choices"][0].get("delta", {})

                text = delta.get("content") or ""
                if text:
                    full_text.append(text)
                    self.on_text(text)
                    yield text

                for tc in delta.get("tool_calls", []):
                    idx = tc.get("index", 0)
                    if idx not in tool_calls_acc:
                        tool_calls_acc[idx] = {
                            "id": tc.get("id", f"tc_{idx}"),
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        }
                    if "function" in tc:
                        fn = tc["function"]
                        if fn.get("name"):
                            tool_calls_acc[idx]["function"]["name"] += fn["name"]
                        if fn.get("arguments"):
                            tool_calls_acc[idx]["function"]["arguments"] += fn["arguments"]

            if not tool_calls_acc:
                break

            asst_msg: dict = {"role": "assistant", "content": "".join(full_text) or None}
            asst_msg["tool_calls"] = list(tool_calls_acc.values())
            messages.append(asst_msg)

            for tc in asst_msg["tool_calls"]:
                self.usage.tool_calls += 1
                name     = tc["function"]["name"]
                args_str = tc["function"].get("arguments", "{}")
                try:
                    args = json.loads(args_str)
                except json.JSONDecodeError:
                    args = {}
                self.on_tool_call(name, args)
                result = self._execute_tool(name, args)
                yield f"\n[tool:{name}] {result[:200]}\n"
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "name": name,
                    "content": result,
                })

    # ── API calls with retry ──────────────────────────────────────────────────

    def _call_api(self, messages: list[dict]) -> dict:
        payload = self._build_payload(messages, stream=False)
        last_exc = None
        for attempt in range(self.cfg.max_retries):
            try:
                return self.router.chat(payload)
            except Exception as exc:
                last_exc = exc
                status = getattr(exc, "status_code", 0)
                if status in (429, 500, 502, 503):
                    wait = self.cfg.retry_base ** attempt
                    log.warning("API error %s, retrying in %.1fs...", status, wait)
                    time.sleep(wait)
                else:
                    raise
        raise last_exc or RuntimeError("All retries failed")

    def _call_api_streaming(self, messages: list[dict]):
        payload = self._build_payload(messages, stream=True)
        last_exc = None
        for attempt in range(self.cfg.max_retries):
            try:
                yield from self.router.stream_chat(payload)
                return
            except Exception as exc:
                last_exc = exc
                status = getattr(exc, "status_code", 0)
                if status in (429, 500, 502, 503):
                    wait = self.cfg.retry_base ** attempt
                    log.warning("Stream API error %s, retrying in %.1fs...", status, wait)
                    time.sleep(wait)
                else:
                    raise
        raise last_exc or RuntimeError("All retries failed")

    def _build_payload(self, messages: list[dict], stream: bool) -> dict:
        payload: dict[str, Any] = {
            "messages": self._inject_system(messages),
            "max_tokens": self.cfg.max_tokens,
            "temperature": self.cfg.temperature,
            "stream": stream,
        }
        if self.tools:
            tool_defs = self.tools.list_tools()
            if tool_defs:
                payload["tools"] = tool_defs
                payload["tool_choice"] = "auto"
        return payload

    def _inject_system(self, messages: list[dict]) -> list[dict]:
        if not self.system_prompt:
            return messages
        if messages and messages[0].get("role") == "system":
            return messages
        return [{"role": "system", "content": self.system_prompt}] + messages

    def _execute_tool(self, name: str, args: dict) -> str:
        if self.tools is None:
            return f"[no tool registry — cannot call {name}]"
        result = self.tools.call(name, args)
        if result.is_error:
            return f"ERROR: {result.error}"
        return result.output or "(empty output)"
