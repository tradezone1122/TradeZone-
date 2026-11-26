"""Agent runtime: tool-calling loop, tool registry, named agents and delegation
(agent-to-agent). The design (agents with tool allowlists, a lead agent delegating to
specialists, bounded steps/depth) follows the concepts in open-multi-agent (MIT), but this
is a fresh Python implementation, not a port of its code."""
from __future__ import annotations
import json, time
from . import store, memory, sandbox, settings, skills
from .router import RouteError

MAX_STEPS = 6
MAX_DEPTH = 2
MAX_DELEGATIONS = 6

DEFAULT_AGENTS = {
    "assistant": {"prompt": "You are a helpful assistant. Use tools when they help.",
                  "tools": ["rag_search", "memory_save", "memory_recall", "skill_read", "artifact_create", "shell"]},
    "researcher": {"prompt": "You research questions using the knowledge base and memory, and cite file names.",
                   "tools": ["rag_search", "memory_recall", "skill_read"]},
    "coder": {"prompt": "You write and run small programs, and publish results as artifacts.",
              "tools": ["shell", "artifact_create"]},
    "lead": {"prompt": "You are a lead agent. Break the task into parts and delegate each to the best specialist "
                       "(researcher, coder) with the delegate tool, then combine the results.",
             "tools": ["delegate", "memory_recall", "memory_save"]},
}

def _fn(name, desc, props, required):
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required}}}

SCHEMAS = {
    "rag_search": _fn("rag_search", "Search the uploaded knowledge base.", {"query": {"type": "string"}}, ["query"]),
    "memory_save": _fn("memory_save", "Save a durable fact to long-term memory.", {"content": {"type": "string"}}, ["content"]),
    "memory_recall": _fn("memory_recall", "Recall saved facts by keywords.", {"query": {"type": "string"}}, ["query"]),
    "skill_read": _fn("skill_read", "Read the instructions of a named skill.", {"name": {"type": "string"}}, ["name"]),
    "artifact_create": _fn("artifact_create", "Publish an artifact (html, svg, markdown, text, code).",
                           {"title": {"type": "string"}, "kind": {"type": "string"}, "content": {"type": "string"}},
                           ["title", "kind", "content"]),
    "shell": _fn("shell", "Run an allow-listed command (argv list) in the workspace.",
                 {"argv": {"type": "array", "items": {"type": "string"}}}, ["argv"]),
    "delegate": _fn("delegate", "Give a sub-task to another agent and get its answer.",
                    {"agent": {"type": "string"}, "task": {"type": "string"}}, ["agent", "task"]),
}

class Ctx:
    def __init__(self, S, session: str, depth: int = 0, trace=None, budget=None):
        self.S, self.session, self.depth = S, session, depth
        self.trace = trace if trace is not None else []
        self.budget = budget if budget is not None else {"delegations": 0}

def _t_rag(c: Ctx, a):  return json.dumps(c.S.rag.search(str(a["query"]), 4))
def _t_msave(c, a):     return json.dumps({"id": memory.save(str(a["content"]))})
def _t_mrecall(c, a):   return json.dumps(memory.recall(str(a["query"])))
def _t_skill(c, a):
    t = skills.read(settings.VENDOR_RAG / "skills", str(a["name"]))
    return t if t else "error: unknown skill"
def _t_art(c, a):       return json.dumps(store.save_artifact(str(a["title"])[:200], str(a["kind"]), str(a["content"])))
def _t_shell(c, a):
    if not c.S.cfg.get("tools_enabled"):
        return "error: shell is disabled (server started without UP_TOOLS=1)"
    return json.dumps(sandbox.run(a["argv"], c.S.cfg["sandbox"]))
def _t_delegate(c, a):
    if c.depth >= MAX_DEPTH:
        return "error: max delegation depth reached"
    if c.budget["delegations"] >= MAX_DELEGATIONS:
        return "error: delegation budget exhausted"
    c.budget["delegations"] += 1
    r = run_agent(c.S, str(a["agent"]), str(a["task"]), c.session, c.depth + 1, c.trace, c.budget)
    return r["answer"]

IMPL = {"rag_search": _t_rag, "memory_save": _t_msave, "memory_recall": _t_mrecall, "skill_read": _t_skill,
        "artifact_create": _t_art, "shell": _t_shell, "delegate": _t_delegate}

def agents(cfg: dict) -> dict:
    return {**DEFAULT_AGENTS, **cfg.get("agents", {})}

def run_agent(S, name: str, task: str, session: str = "default", depth: int = 0, trace=None, budget=None) -> dict:
    defs = agents(S.cfg)
    if name not in defs:
        return {"agent": name, "answer": f"error: unknown agent {name!r}", "steps": 0, "trace": trace or []}
    d = defs[name]
    ctx = Ctx(S, session, depth, trace, budget)
    allowed = [t for t in d["tools"] if t in IMPL]
    mem = memory.recall(task, k=3)
    sysmsg = d["prompt"] + (("\n\nRelevant memory:\n" + "\n".join("- " + m["content"] for m in mem)) if mem else "")
    msgs = [{"role": "system", "content": sysmsg}, {"role": "user", "content": task}]
    answer, steps = "", 0
    for steps in range(1, MAX_STEPS + 1):
        payload = {"messages": msgs, "tools": [SCHEMAS[t] for t in allowed]} if allowed else {"messages": msgs}
        status, data = S.router.complete(payload)
        if status != 200:
            raise RouteError(f"upstream error {status}: {str(data)[:200]}", 502)
        try:
            m = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError):
            raise RouteError("malformed upstream response", 502)
        calls = m.get("tool_calls") or []
        if not calls:
            answer = m.get("content") or ""
            break
        msgs.append({"role": "assistant", "content": m.get("content"), "tool_calls": calls})
        for tc in calls:
            fname = tc.get("function", {}).get("name", "")
            t0 = time.time()
            try:
                if fname not in allowed:
                    out = f"error: agent {name!r} may not use tool {fname!r}"
                else:
                    args = json.loads(tc["function"].get("arguments") or "{}")
                    out = IMPL[fname](ctx, args)
            except Exception as e:      # tool failure goes back to the model, loop continues
                out = f"error: {type(e).__name__}: {e}"
            ctx.trace.append({"agent": name, "depth": depth, "tool": fname,
                              "ok": not str(out).startswith("error:"), "ms": int((time.time() - t0) * 1000)})
            msgs.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": str(out)[:8000]})
    else:
        answer = "error: step limit reached without a final answer"
    if depth == 0:
        store.add_message(session, "user", task); store.add_message(session, "assistant", answer, name)
    return {"agent": name, "answer": answer, "steps": steps, "trace": ctx.trace}
