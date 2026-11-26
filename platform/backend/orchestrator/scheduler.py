"""
Orchestrator Scheduler — P3
Executes tasks in dependency order using asyncio.
Ready tasks (all deps done) run in parallel up to MAX_PARALLEL.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Callable, Optional

from .. import orch_store as store
from ..events import get_bus
from ..workspaces import get_manager as get_ws_manager

MAX_PARALLEL = 4


# ── Task executor callback type ──────────────────────────────────────────────
# Signature: async (task: store.Task, workspace_root: str) -> str (result)
TaskExecutor = Callable[[store.Task, str], "asyncio.Coroutine[None, None, str]"]


# ── Scheduler ────────────────────────────────────────────────────────────────

class Scheduler:
    """
    Runs a DAG of tasks for one orchestrator run.
    Publishes progress events to the event bus.
    """

    def __init__(self, run_id: str, executor: TaskExecutor,
                 source_path: Optional[str] = None):
        self.run_id      = run_id
        self.executor    = executor
        self.source_path = source_path
        self.bus         = get_bus()
        self.ws          = get_ws_manager()

    async def run(self) -> bool:
        """Execute all tasks for this run. Returns True if all succeeded."""
        store.update_run_status(self.run_id, "running")
        await self._emit("run_started", {"run_id": self.run_id})

        success = True
        semaphore = asyncio.Semaphore(MAX_PARALLEL)

        # Map task id → asyncio.Event (fires when task finishes)
        task_done: dict[str, asyncio.Event] = {}
        tasks = store.list_tasks(self.run_id)
        for t in tasks:
            task_done[t.id] = asyncio.Event()

        async def run_one(task: store.Task) -> None:
            nonlocal success
            # Wait for all dependencies
            for dep_id in [d for d in task.depends_on.split(",") if d]:
                ev = task_done.get(dep_id)
                if ev:
                    await ev.wait()
                # If dep failed, skip this task
                dep = store.get_task(dep_id)
                if dep and dep.status == "failed":
                    store.update_task(task.id, status="skipped",
                                      error=f"dep {dep_id} failed")
                    task_done[task.id].set()
                    await self._emit("task_skipped", {"task_id": task.id})
                    return

            async with semaphore:
                await self._run_task(task, task_done)
                if store.get_task(task.id).status == "failed":
                    success = False

        await asyncio.gather(*(run_one(t) for t in tasks))

        final_status = "done" if success else "failed"
        store.update_run_status(self.run_id, final_status)
        await self._emit("run_done", {"run_id": self.run_id, "status": final_status})
        return success

    async def _run_task(self, task: store.Task,
                        task_done: dict[str, asyncio.Event]) -> None:
        store.update_task(task.id, status="running")
        await self._emit("task_started", {"task_id": task.id, "name": task.name})

        ws_root = ""
        ws_id   = None
        if self.source_path:
            try:
                ws = self.ws.create(self.run_id, task.id, self.source_path)
                ws_id    = ws.id
                ws_root  = str(ws.root)
                store.update_task(task.id, workspace_id=ws_id)
            except Exception as e:
                # Workspace creation failure is non-fatal — task runs without isolation
                await self._emit("task_warn", {"task_id": task.id,
                                               "msg": f"workspace failed: {e}"})

        try:
            result = await self.executor(task, ws_root)
            store.update_task(task.id, status="done", result=result[:4000] if result else "")
            await self._emit("task_done", {"task_id": task.id, "result": result[:500] if result else ""})
        except Exception as exc:
            err = str(exc)[:800]
            store.update_task(task.id, status="failed", error=err)
            await self._emit("task_failed", {"task_id": task.id, "error": err})
        finally:
            if ws_id:
                try:
                    self.ws.destroy(ws_id)
                except Exception:
                    pass
            task_done[task.id].set()

    async def _emit(self, event_type: str, payload: dict) -> None:
        payload["type"] = event_type
        payload["run_id"] = self.run_id
        payload["ts"] = time.time()
        await self.bus.publish(self.run_id, payload)
        store.add_event(
            task_id=payload.get("task_id", ""),
            run_id=self.run_id,
            event_type=event_type,
            payload=json.dumps(payload),
        )
