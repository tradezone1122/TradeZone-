"""
Multi-agent REST API endpoints.
POST /agents/pool/run   — run a named agent from the pool
GET  /agents/pool       — list registered agents
POST /agents/pool/chat  — multi-turn agent conversation
"""
from __future__ import annotations

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import settings
from .multi_agent import Agent, AgentPool, make_search_tool, make_memory_tool, make_delegate_tool
from .router import Router


def _build_default_pool() -> AgentPool:
    cfg = settings.load()
    router = Router(cfg)
    pool = AgentPool()
    pool.set_router(router)
    model = cfg.get("default_model", "default")

    research_agent = Agent(name="researcher", system_prompt="You are a research agent. Use search_knowledge to find relevant information. Save important findings to memory. Provide comprehensive, well-sourced answers.", model=model)
    code_agent = Agent(name="coder", system_prompt="You are an expert software engineer. Write clean, correct, production-quality code. Explain your code and decisions clearly.", model=model)
    planner_agent = Agent(name="planner", system_prompt="You are a strategic planner. Break down complex goals into concrete, ordered steps. Be specific and actionable. Delegate subtasks when appropriate.", model=model)
    writer_agent = Agent(name="writer", system_prompt="You are a professional writer and editor. Produce clear, engaging, well-structured text. Adapt your style to the requested format and audience.", model=model)
    analyst_agent = Agent(name="analyst", system_prompt="You are a data analyst. Analyze information critically, identify patterns, draw evidence-based conclusions, and present findings clearly.", model=model)

    for agent in [research_agent, code_agent, planner_agent, writer_agent, analyst_agent]:
        agent.tools["save_memory"] = make_memory_tool(agent)
        agent.tools["delegate_task"] = make_delegate_tool(pool, agent.name)
        pool.register(agent)

    try:
        from .rag import Rag
        rag = Rag()
        if rag.count() > 0:
            search_tool = make_search_tool(rag)
            for agent in pool._agents.values():
                agent.tools[search_tool.name] = search_tool
    except Exception:
        pass

    return pool


_pool: AgentPool | None = None


def get_pool() -> AgentPool:
    global _pool
    if _pool is None:
        _pool = _build_default_pool()
    return _pool


async def pool_list(request: Request) -> JSONResponse:
    return JSONResponse({"agents": get_pool().list_agents()})


async def pool_run(request: Request) -> JSONResponse:
    try:
        body = await request.json()
        agent_name = str(body.get("agent", "researcher"))
        task = str(body.get("task", "")).strip()
    except (ValueError, KeyError):
        return JSONResponse({"error": "JSON body with 'agent' and 'task' required"}, status_code=400)
    if not task:
        return JSONResponse({"error": "task required"}, status_code=400)
    from starlette.concurrency import run_in_threadpool
    result = await run_in_threadpool(get_pool().run, agent_name, task)
    return JSONResponse({"agent": agent_name, "result": result})


async def pool_chat(request: Request) -> JSONResponse:
    try:
        body = await request.json()
        agent_name = str(body.get("agent", "researcher"))
        messages: list[dict] = body.get("messages", [])
        if not messages:
            return JSONResponse({"error": "messages required"}, status_code=400)
        task = str(messages[-1].get("content", "")).strip()
    except (ValueError, KeyError):
        return JSONResponse({"error": "invalid JSON"}, status_code=400)
    from starlette.concurrency import run_in_threadpool
    result = await run_in_threadpool(get_pool().run, agent_name, task)
    return JSONResponse({"agent": agent_name, "result": result, "message": {"role": "assistant", "content": result}})


ROUTES = [
    Route("/agents/pool",       pool_list,  methods=["GET"]),
    Route("/agents/pool/run",   pool_run,   methods=["POST"]),
    Route("/agents/pool/chat",  pool_chat,  methods=["POST"]),
]
