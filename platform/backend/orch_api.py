"""
Orchestrator + Skills REST API — P3
Mounts under /orch/* and /skills/*
Added to app.py via include_router pattern.
"""
from __future__ import annotations

import asyncio
import json

from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from . import orch_store as store
from . import settings
from .events import get_bus
from .orchestrator.planner import plan
from .orchestrator.scheduler import Scheduler
from .router import Router
from .skills_engine import get_registry


# ── Default task executor (uses platform router) ─────────────────────────────

async def _default_executor(task: store.Task, workspace_root: str) -> str:
    cfg = settings.load()
    router = Router(cfg)

    system = (
        f"You are an AI agent. Complete the following task precisely.\n"
        f"Workspace directory: {workspace_root or '(none)'}\n"
        f"Task: {task.name}\n"
    )
    payload = {
        "model": cfg.get("default_model") or "default",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": task.description},
        ],
        "max_tokens": 4096,
    }
    status, resp = router.complete(payload)
    if status != 200:
        raise RuntimeError(f"LLM error {status}")
    return resp["choices"][0]["message"]["content"]


# ── Orchestrator endpoints ───────────────────────────────────────────────────

async def orch_start(request: Request) -> JSONResponse:
    """POST /orch/start  { goal, model?, source_path? }"""
    body = await request.json()
    goal        = body.get("goal", "").strip()
    model       = body.get("model")
    source_path = body.get("source_path")

    if not goal:
        return JSONResponse({"error": "goal required"}, status_code=400)

    # 1. Create run
    run = store.create_run(goal=goal, model=model)

    # 2. Plan tasks via LLM
    try:
        task_defs = plan(goal, model=model)
    except Exception as exc:
        store.update_run_status(run.id, "failed")
        return JSONResponse({"error": f"planning failed: {exc}"}, status_code=500)

    # 3. Persist tasks
    id_map: dict[str, str] = {}
    for td in task_defs:
        deps = [id_map[d] for d in td.get("depends_on", []) if d in id_map]
        t = store.create_task(run.id, td["name"], td.get("description", ""), deps)
        id_map[td["id"]] = t.id

    # 4. Launch scheduler in background
    sched = Scheduler(run.id, _default_executor, source_path=source_path)
    asyncio.create_task(sched.run())

    tasks_out = [
        {"id": t.id, "name": t.name, "status": t.status}
        for t in store.list_tasks(run.id)
    ]
    return JSONResponse({"run_id": run.id, "tasks": tasks_out})


async def orch_status(request: Request) -> JSONResponse:
    """GET /orch/{run_id}/status"""
    run_id = request.path_params["run_id"]
    run = store.get_run(run_id)
    if not run:
        return JSONResponse({"error": "not found"}, status_code=404)
    tasks = [
        {"id": t.id, "name": t.name, "status": t.status,
         "result": t.result, "error": t.error}
        for t in store.list_tasks(run_id)
    ]
    return JSONResponse({
        "run_id": run.id, "status": run.status,
        "goal": run.goal, "tasks": tasks,
    })


async def orch_events(request: Request) -> StreamingResponse:
    """GET /orch/{run_id}/events  — SSE stream"""
    run_id = request.path_params["run_id"]

    async def generator():
        bus = get_bus()
        async for event in bus.subscribe(run_id, replay_history=True, timeout=300):
            yield event.to_sse()

    return StreamingResponse(generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


async def orch_runs(request: Request) -> JSONResponse:
    """GET /orch/runs"""
    runs = store.list_runs(limit=50)
    return JSONResponse([{
        "id": r.id, "goal": r.goal, "status": r.status,
        "created_at": r.created_at,
    } for r in runs])


# ── Skills endpoints ─────────────────────────────────────────────────────────

async def skills_list(request: Request) -> JSONResponse:
    """GET /skills"""
    reg = get_registry()
    return JSONResponse(reg.list())


async def skills_get(request: Request) -> JSONResponse:
    """GET /skills/{skill_id}"""
    skill_id = request.path_params["skill_id"]
    skill = get_registry().get(skill_id)
    if not skill:
        return JSONResponse({"error": "skill not found"}, status_code=404)
    return JSONResponse({"name": skill.name, "description": skill.description,
                         "prompt": skill.prompt[:500] + "..."})


# ── Route list (append to app routes) ────────────────────────────────────────

ROUTES = [
    Route("/orch/start",              orch_start,   methods=["POST"]),
    Route("/orch/runs",               orch_runs,    methods=["GET"]),
    Route("/orch/{run_id}/status",    orch_status,  methods=["GET"]),
    Route("/orch/{run_id}/events",    orch_events,  methods=["GET"]),
    Route("/skills",                  skills_list,  methods=["GET"]),
    Route("/skills/{skill_id}",       skills_get,   methods=["GET"]),
]
