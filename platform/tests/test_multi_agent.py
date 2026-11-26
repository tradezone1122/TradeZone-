"""Tests for backend/multi_agent.py"""
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.multi_agent import Agent, AgentPool, Tool


def _echo_tool(text: str) -> str:
    return f"echo:{text}"


def make_tool(name: str = "echo") -> Tool:
    return Tool(
        name=name,
        description="Echoes input",
        parameters={"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        fn=_echo_tool,
    )


def test_tool_to_openai():
    t = make_tool("my_tool")
    d = t.to_openai()
    assert d["type"] == "function"
    assert d["function"]["name"] == "my_tool"
    assert "parameters" in d["function"]


def test_tool_fn_called():
    t = make_tool()
    assert t.fn(text="hello") == "echo:hello"


def test_agent_init():
    a = Agent("test-agent", "You are a helper", tools=[make_tool()])
    assert a.name == "test-agent"
    assert "echo" in a.tools


def test_agent_remember():
    a = Agent("a", "sys")
    a.remember("fact1")
    a.remember("fact2")
    assert len(a.state.memory) == 2
    assert "fact1" in a.state.memory


def test_agent_call_tool():
    a = Agent("a", "sys", tools=[make_tool()])
    result = a._call_tool("echo", '{"text": "world"}')
    assert result == "echo:world"


def test_agent_call_missing_tool():
    a = Agent("a", "sys")
    result = a._call_tool("nonexistent", "{}")
    assert "not found" in result


def test_pool_register_and_get():
    pool = AgentPool()
    agent = Agent("alpha", "sys")
    pool.register(agent)
    assert pool.get("alpha") is agent
    assert pool.get("missing") is None


def test_pool_list_agents():
    pool = AgentPool()
    pool.register(Agent("a1", "sys", tools=[make_tool("t1")]))
    pool.register(Agent("a2", "sys"))
    agents = pool.list_agents()
    names = [ag["name"] for ag in agents]
    assert "a1" in names
    assert "a2" in names
    a1_entry = next(ag for ag in agents if ag["name"] == "a1")
    assert "t1" in a1_entry["tools"]


def test_pool_run_missing_agent():
    pool = AgentPool()
    result = pool.run("nonexistent", "do something")
    assert "not found" in result
