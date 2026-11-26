"""
Orchestrator Planner — P3
Breaks a goal into a DAG of tasks via LLM call.
Uses the platform router (OpenAI-compatible) — works with Kimi K3 Pro or any model.
"""
from __future__ import annotations

import json
import re
from typing import Optional

from .. import settings
from ..router import Router


_SYSTEM_PROMPT = """You are a software project planner. Break the user's goal into concrete, executable tasks.

Output ONLY valid JSON in this exact format:
{
  "tasks": [
    {
      "id": "t1",
      "name": "short task name",
      "description": "what exactly to do",
      "depends_on": []
    },
    {
      "id": "t2",
      "name": "another task",
      "description": "what to do",
      "depends_on": ["t1"]
    }
  ]
}

Rules:
- Each task must have a unique id (t1, t2, t3...)
- depends_on lists ids of tasks that must complete first
- Keep tasks small and independent where possible
- Maximum 10 tasks
- No markdown, no explanation — JSON only"""


def plan(goal: str, model: Optional[str] = None) -> list[dict]:
    """
    Call the LLM to decompose goal into tasks.
    Returns list of task dicts: [{id, name, description, depends_on}, ...]
    """
    cfg = settings.load()
    router = Router(cfg)

    payload = {
        "model": model or cfg.get("default_model") or "default",
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",   "content": f"Goal: {goal}"},
        ],
        "temperature": 0.2,
        "max_tokens": 2000,
    }

    status, resp = router.complete(payload)
    if status != 200:
        raise RuntimeError(f"Planner LLM error {status}: {resp}")

    raw = resp["choices"][0]["message"]["content"]
    return _parse_tasks(raw)


def _parse_tasks(raw: str) -> list[dict]:
    """Extract JSON from LLM response (handles markdown code blocks)."""
    # strip ```json ... ``` if present
    text = re.sub(r"```(?:json)?\s*", "", raw).replace("```", "").strip()

    # find first { ... }
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError(f"No JSON found in planner response: {raw[:200]}")

    data = json.loads(m.group(0))
    tasks = data.get("tasks", [])
    if not isinstance(tasks, list):
        raise ValueError("Planner response missing 'tasks' array")

    # validate minimal structure
    for t in tasks:
        if not all(k in t for k in ("id", "name", "description")):
            raise ValueError(f"Malformed task entry: {t}")
        t.setdefault("depends_on", [])

    return tasks
