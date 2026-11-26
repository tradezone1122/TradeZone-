"""
Multi-agent execution layer.
Provides Agent, AgentPool and tool registration — independent of any specific LLM.
All calls go through the platform Router (OpenAI-compatible), so it works with
Kimi K3 Pro, any local model, or any fine-tuned custom model.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

log = logging.getLogger("multi_agent")


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    fn: Callable[..., Any]

    def to_openai(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass
class AgentState:
    messages: list[dict] = field(default_factory=list)
    memory: list[str] = field(default_factory=list)
    context: dict = field(default_factory=dict)


class Agent:
    """Single agent with tools and memory."""

    def __init__(
        self,
        name: str,
        system_prompt: str,
        tools: list[Tool] | None = None,
        model: str | None = None,
        max_turns: int = 20,
    ):
        self.name = name
        self.system_prompt = system_prompt
        self.tools = {t.name: t for t in (tools or [])}
        self.model = model
        self.max_turns = max_turns
        self.state = AgentState()

    def _build_messages(self, user_message: str) -> list[dict]:
        msgs = [{"role": "system", "content": self.system_prompt}]
        if self.state.memory:
            mem_text = "\n".join(f"- {m}" for m in self.state.memory[-10:])
            msgs.append({"role": "system", "content": f"Memory:\n{mem_text}"})
        msgs.extend(self.state.messages)
        msgs.append({"role": "user", "content": user_message})
        return msgs

    def _call_tool(self, tool_name: str, arguments: str) -> str:
        tool = self.tools.get(tool_name)
        if not tool:
            return f"Error: tool '{tool_name}' not found"
        try:
            args = json.loads(arguments) if isinstance(arguments, str) else arguments
            result = tool.fn(**args)
            return str(result)
        except Exception as e:
            return f"Tool error: {e}"

    def run(self, task: str, router=None) -> str:
        if router is None:
            from . import settings
            from .router import Router
            router = Router(settings.load())

        self.state.messages = []
        messages = self._build_messages(task)

        for turn in range(self.max_turns):
            payload: dict = {
                "model": self.model or "default",
                "messages": messages,
                "max_tokens": 4096,
            }
            if self.tools:
                payload["tools"] = [t.to_openai() for t in self.tools.values()]
                payload["tool_choice"] = "auto"

            status, resp = router.complete(payload)
            if status != 200:
                log.error("Router error %d: %s", status, resp)
                return f"[error: LLM returned {status}]"

            choice = resp["choices"][0]
            message = choice["message"]
            messages.append(message)

            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                content = message.get("content", "")
                self.state.messages = messages[1:]
                return content

            for tc in tool_calls:
                tool_name = tc["function"]["name"]
                arguments  = tc["function"].get("arguments", "{}")
                result = self._call_tool(tool_name, arguments)
                log.debug("[%s] tool %s → %s", self.name, tool_name, result[:100])
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": result,
                })

        return "[max turns reached]"

    def remember(self, fact: str) -> None:
        self.state.memory.append(fact)


class AgentPool:
    """Pool of named agents that can delegate to each other."""

    def __init__(self):
        self._agents: dict[str, Agent] = {}
        self._router = None

    def register(self, agent: Agent) -> None:
        self._agents[agent.name] = agent

    def get(self, name: str) -> Optional[Agent]:
        return self._agents.get(name)

    def set_router(self, router) -> None:
        self._router = router

    def run(self, agent_name: str, task: str) -> str:
        agent = self._agents.get(agent_name)
        if not agent:
            return f"[error: agent '{agent_name}' not found]"
        return agent.run(task, router=self._router)

    def list_agents(self) -> list[dict]:
        return [
            {"name": a.name, "tools": list(a.tools.keys())}
            for a in self._agents.values()
        ]


def make_search_tool(rag) -> Tool:
    def search(query: str, k: int = 5) -> str:
        hits = rag.search(query, k)
        if not hits:
            return "No results found."
        return "\n\n".join(f"[{h['filename']}]\n{h['content']}" for h in hits)

    return Tool(
        name="search_knowledge",
        description="Search the knowledge base for relevant documents",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "k": {"type": "integer", "description": "Max results", "default": 5},
            },
            "required": ["query"],
        },
        fn=search,
    )


def make_memory_tool(agent: Agent) -> Tool:
    def save_memory(fact: str) -> str:
        agent.remember(fact)
        return f"Saved: {fact}"

    return Tool(
        name="save_memory",
        description="Save an important fact to memory for future reference",
        parameters={
            "type": "object",
            "properties": {"fact": {"type": "string", "description": "Fact to remember"}},
            "required": ["fact"],
        },
        fn=save_memory,
    )


def make_delegate_tool(pool: AgentPool, delegator_name: str) -> Tool:
    def delegate(agent: str, task: str) -> str:
        if agent == delegator_name:
            return "Error: cannot delegate to yourself"
        return pool.run(agent, task)

    return Tool(
        name="delegate_task",
        description="Delegate a subtask to a specialized agent",
        parameters={
            "type": "object",
            "properties": {
                "agent": {"type": "string", "description": "Name of the agent to delegate to"},
                "task": {"type": "string", "description": "The task to delegate"},
            },
            "required": ["agent", "task"],
        },
        fn=delegate,
    )
