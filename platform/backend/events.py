"""
SSE Event Bus — P2
asyncio-based pub/sub for orchestrator → frontend streaming.

Usage:
    bus = get_bus()
    # publisher:
    await bus.publish("run_id", {"type": "task_started", "task_id": "..."})
    # subscriber (SSE endpoint):
    async for event in bus.subscribe("run_id"):
        yield f"data: {json.dumps(event)}\n\n"
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import AsyncGenerator, Optional


@dataclass
class Event:
    run_id: str
    payload: dict
    ts: float = field(default_factory=time.time)

    def to_sse(self) -> str:
        return f"data: {json.dumps(self.payload)}\n\n"


class EventBus:
    """
    Per-run pub/sub over asyncio.Queue.
    Subscribers receive events published after they subscribed.
    """

    def __init__(self, maxsize: int = 256):
        self._maxsize = maxsize
        # run_id → list of active queues
        self._subs: dict[str, list[asyncio.Queue]] = {}
        # run_id → recent history (capped)
        self._history: dict[str, list[Event]] = {}
        self._history_cap = 100

    # ── Publish ──────────────────────────────────────────────────────────────

    async def publish(self, run_id: str, payload: dict) -> None:
        event = Event(run_id=run_id, payload=payload)
        # save to history
        hist = self._history.setdefault(run_id, [])
        hist.append(event)
        if len(hist) > self._history_cap:
            hist.pop(0)
        # fan out to active subscribers
        for q in list(self._subs.get(run_id, [])):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # slow subscriber — drop event rather than block

    def publish_sync(self, run_id: str, payload: dict) -> None:
        """Thread-safe publish from sync code (uses running loop)."""
        try:
            loop = asyncio.get_running_loop()
            loop.call_soon_threadsafe(
                loop.create_task, self.publish(run_id, payload)
            )
        except RuntimeError:
            pass  # no running loop — event dropped silently

    # ── Subscribe ────────────────────────────────────────────────────────────

    async def subscribe(
        self,
        run_id: str,
        replay_history: bool = False,
        timeout: float = 60.0,
    ) -> AsyncGenerator[Event, None]:
        """
        Async generator that yields events for a run.
        Ends when the run publishes a {"type": "run_done"} event or timeout fires.
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=self._maxsize)
        subs = self._subs.setdefault(run_id, [])
        subs.append(q)
        try:
            if replay_history:
                for ev in list(self._history.get(run_id, [])):
                    yield ev
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=min(remaining, 5.0))
                except asyncio.TimeoutError:
                    # send keepalive comment so the SSE connection stays alive
                    yield Event(run_id=run_id, payload={"type": "keepalive"})
                    continue
                yield event
                if event.payload.get("type") == "run_done":
                    break
        finally:
            try:
                subs.remove(q)
            except ValueError:
                pass

    # ── Utility ──────────────────────────────────────────────────────────────

    def history(self, run_id: str) -> list[Event]:
        return list(self._history.get(run_id, []))

    def clear(self, run_id: str) -> None:
        self._subs.pop(run_id, None)
        self._history.pop(run_id, None)

    def active_runs(self) -> list[str]:
        return [rid for rid, subs in self._subs.items() if subs]


# ── Module-level singleton ───────────────────────────────────────────────────

_bus: Optional[EventBus] = None


def get_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus
