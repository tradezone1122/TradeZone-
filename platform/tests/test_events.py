"""Tests for backend/events.py — P2"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.events import EventBus, Event, get_bus


@pytest.fixture
def bus():
    return EventBus(maxsize=64)


# ── publish / history ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_publish_adds_to_history(bus):
    await bus.publish("run1", {"type": "task_started", "task_id": "t1"})
    hist = bus.history("run1")
    assert len(hist) == 1
    assert hist[0].payload["type"] == "task_started"


@pytest.mark.asyncio
async def test_history_capped(bus):
    bus._history_cap = 5
    for i in range(10):
        await bus.publish("run1", {"type": "x", "i": i})
    assert len(bus.history("run1")) == 5


@pytest.mark.asyncio
async def test_history_isolated_per_run(bus):
    await bus.publish("run1", {"type": "a"})
    await bus.publish("run2", {"type": "b"})
    assert len(bus.history("run1")) == 1
    assert len(bus.history("run2")) == 1


# ── subscribe + receive ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_subscribe_receives_events(bus):
    received = []

    async def publisher():
        await asyncio.sleep(0.01)
        await bus.publish("run1", {"type": "step", "n": 1})
        await bus.publish("run1", {"type": "run_done"})

    async def subscriber():
        async for ev in bus.subscribe("run1", timeout=5.0):
            received.append(ev.payload)

    await asyncio.gather(publisher(), subscriber())
    types = [e["type"] for e in received]
    assert "step" in types
    assert "run_done" in types


@pytest.mark.asyncio
async def test_subscribe_replay_history(bus):
    await bus.publish("run1", {"type": "old"})
    received = []

    async def publisher():
        await asyncio.sleep(0.01)
        await bus.publish("run1", {"type": "run_done"})

    async def subscriber():
        async for ev in bus.subscribe("run1", replay_history=True, timeout=3.0):
            received.append(ev.payload)

    await asyncio.gather(publisher(), subscriber())
    types = [e["type"] for e in received]
    assert "old" in types


@pytest.mark.asyncio
async def test_multiple_subscribers_fanout(bus):
    r1, r2 = [], []

    async def sub1():
        async for ev in bus.subscribe("run1", timeout=3.0):
            r1.append(ev.payload["type"])

    async def sub2():
        async for ev in bus.subscribe("run1", timeout=3.0):
            r2.append(ev.payload["type"])

    async def pub():
        await asyncio.sleep(0.02)
        await bus.publish("run1", {"type": "event_x"})
        await bus.publish("run1", {"type": "run_done"})

    await asyncio.gather(pub(), sub1(), sub2())
    assert "event_x" in r1
    assert "event_x" in r2


# ── clear ─────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_clear_removes_history(bus):
    await bus.publish("run1", {"type": "a"})
    bus.clear("run1")
    assert bus.history("run1") == []


# ── active_runs ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_active_runs(bus):
    done = asyncio.Event()

    async def sub():
        async for _ in bus.subscribe("run1", timeout=3.0):
            done.set()
            break

    task = asyncio.create_task(sub())
    await asyncio.sleep(0.02)
    assert "run1" in bus.active_runs()
    await bus.publish("run1", {"type": "run_done"})
    await task


# ── Event SSE serialisation ───────────────────────────────────────────────────

def test_event_to_sse():
    ev = Event(run_id="r", payload={"type": "x", "v": 1})
    sse = ev.to_sse()
    assert sse.startswith("data: ")
    assert '"type": "x"' in sse
    assert sse.endswith("\n\n")
