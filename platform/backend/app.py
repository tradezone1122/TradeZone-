"""Unified platform HTTP app (Starlette). Serves the chat UI (from Splaude, Apache-2.0)
and the API it expects (/v1/models, /v1/chat/completions) plus RAG, uploads, skills,
tools, sessions and artifacts."""
from __future__ import annotations
import json, logging, re, secrets
from pathlib import Path
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, HTMLResponse, StreamingResponse, FileResponse, Response
from starlette.routing import Route, Mount
from starlette.staticfiles import StaticFiles

from . import settings, store, sandbox, skills, memory, agents
from .router import Router, RouteError
from .orch_api import ROUTES as ORCH_ROUTES

log = logging.getLogger("platform")

class State:
    cfg: dict; router: Router; rag = None; token: str | None = None
S = State()

def init(cfg: dict | None = None, rag=None) -> None:
    S.cfg = cfg or settings.load()
    S.router = Router(S.cfg)
    if rag is None:
        from .rag import Rag
        rag = Rag()
    S.rag = rag
    S.token = secrets.token_urlsafe(24) if S.cfg.get("tools_enabled") else None

def err(msg: str, status: int = 400):
    return JSONResponse({"error": {"message": msg}}, status_code=status)

def _text(content) -> str:
    if isinstance(content, str):
        return content
    return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")

def _inject_rag(payload: dict) -> tuple[dict, list]:
    rc = S.cfg["rag"]
    if not rc.get("enabled") or S.rag is None or S.rag.count() == 0:
        return payload, []
    users = [m for m in payload.get("messages", []) if m.get("role") == "user"]
    if not users:
        return payload, []
    hits = S.rag.search(_text(users[-1]["content"]), rc["top_k"])
    if not hits:
        return payload, []
    ctx, used = [], 0
    for h in hits:
        piece = f"[{h['filename']}]\n{h['content']}"
        if used + len(piece) > rc["max_chars"]:
            break
        ctx.append(piece); used += len(piece)
    sysmsg = {"role": "system", "content": "Use the following retrieved context when relevant and cite file names.\n\n" + "\n\n".join(ctx)}
    return {**payload, "messages": [sysmsg, *payload["messages"]]}, hits

async def models(request: Request):
    return JSONResponse({"object": "list", "data": S.router.models()})

async def chat(request: Request):
    try:
        payload = await request.json()
    except ValueError:
        return err("invalid JSON")
    if not isinstance(payload.get("messages"), list) or not payload["messages"]:
        return err("messages required")
    session = request.headers.get("x-session-id", "default")[:64]
    last = payload["messages"][-1]
    store.add_message(session, last.get("role", "user"), _text(last.get("content", "")))
    payload, _ = _inject_rag(payload)
    try:
        if not payload.get("stream"):
            status, data = S.router.complete(payload)
            try:
                store.add_message(session, "assistant", data["choices"][0]["message"]["content"] or "", payload.get("model"))
            except (KeyError, IndexError, TypeError):
                pass
            return JSONResponse(data, status_code=status)
        status, it = S.router.stream(payload)
    except RouteError as e:
        return err(str(e), e.status)
    if status != 200:
        return Response(b"".join(it), status_code=status, media_type="application/json")
    def gen():
        buf, text = b"", []
        for chunk in it:
            yield chunk
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.startswith(b"data:") and b"[DONE]" not in line:
                    try:
                        d = json.loads(line[5:])
                        text.append(d["choices"][0]["delta"].get("content") or "")
                    except (ValueError, KeyError, IndexError):
                        pass
        store.add_message(session, "assistant", "".join(text), payload.get("model"))
    return StreamingResponse(gen(), media_type="text/event-stream")

async def upload(request: Request):
    name = re.sub(r"[^A-Za-z0-9._-]", "_", request.query_params.get("filename", ""))[:100]
    if not name or name.startswith("."):
        return err("filename query parameter required")
    body = b""
    async for c in request.stream():
        body += c
        if len(body) > S.cfg["max_upload_bytes"]:
            return err("file too large", 413)
    d = settings.STORAGE / "uploads"; d.mkdir(parents=True, exist_ok=True)
    path = d / name
    path.write_bytes(body)
    try:
        n = S.rag.ingest(path, name)
    except Exception as e:
        return err(f"saved but not indexed: {e}", 422)
    return JSONResponse({"filename": name, "bytes": len(body), "chunks_indexed": n})

async def rag_search(request: Request):
    q = request.query_params.get("q", "")
    return JSONResponse({"query": q, "hits": S.rag.search(q, int(request.query_params.get("k", 4))) if q else []})

async def skills_list(request: Request):
    return JSONResponse({"skills": skills.scan(settings.VENDOR_RAG / "skills")})

def _tool_auth(request: Request):
    if not S.cfg.get("tools_enabled"):
        return err("tools disabled (set UP_TOOLS=1)", 403)
    if not secrets.compare_digest(request.headers.get("x-admin-token", ""), S.token or ""):
        return err("bad or missing X-Admin-Token", 401)

async def tool_run(request: Request):
    if (bad := _tool_auth(request)):
        return bad
    try:
        b = await request.json()
        return JSONResponse(sandbox.run(b.get("argv"), S.cfg["sandbox"], b.get("stdin")))
    except sandbox.SandboxError as e:
        return err(str(e), 403)
    except ValueError:
        return err("invalid JSON")

async def agent_run(request: Request):
    if S.cfg.get("tools_enabled") and (bad := _tool_auth(request)):
        return bad
    try:
        b = await request.json()
        task = str(b["task"]).strip()
    except (ValueError, KeyError):
        return err("JSON body with 'task' required")
    if not task or len(task) > 20000:
        return err("task must be 1-20000 characters")
    name = str(b.get("agent", "assistant"))
    if name not in agents.agents(S.cfg):
        return err(f"unknown agent {name!r}", 404)
    from starlette.concurrency import run_in_threadpool
    try:
        r = await run_in_threadpool(agents.run_agent, S, name, task, str(b.get("session", "default"))[:64])
    except RouteError as e:
        return err(str(e), e.status)
    return JSONResponse(r)

async def agents_list(request: Request):
    return JSONResponse({"agents": [{"name": n, "tools": d["tools"], "prompt": d["prompt"]}
                                    for n, d in agents.agents(S.cfg).items()]})

async def mem_list(request: Request):
    return JSONResponse({"memories": memory.list_all()})

async def mem_save(request: Request):
    try:
        b = await request.json()
        return JSONResponse({"id": memory.save(str(b["content"]))}, status_code=201)
    except (ValueError, KeyError) as e:
        return err(f"bad memory: {e}")

async def mem_delete(request: Request):
    return JSONResponse({"deleted": True}) if memory.delete(int(request.path_params["mid"])) else err("not found", 404)

async def panel(request: Request):
    return FileResponse(settings.ROOT / "frontend" / "panel.html")

async def history(request: Request):
    return JSONResponse({"messages": store.history(request.query_params.get("session", "default"))})

async def sessions(request: Request):
    return JSONResponse({"sessions": store.sessions()})

async def art_create(request: Request):
    try:
        b = await request.json()
        r = store.save_artifact(str(b["title"])[:200], b["kind"], str(b["content"]), b.get("id"))
        return JSONResponse(r, status_code=201)
    except (KeyError, ValueError) as e:
        return err(f"bad artifact: {e}", 404 if isinstance(e, KeyError) and e.args and len(str(e.args[0])) == 12 else 400)

async def art_list(request: Request):
    return JSONResponse({"artifacts": store.list_artifacts()})

def _art(request: Request):
    v = request.query_params.get("v")
    return store.get_artifact(request.path_params["aid"], int(v) if v and v.isdigit() else None)

async def art_get(request: Request):
    a = _art(request)
    return JSONResponse(a) if a else err("not found", 404)

CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"

async def art_raw(request: Request):
    """Artifact content with a sandboxing CSP (no same-origin, no network)."""
    a = _art(request)
    if not a:
        return err("not found", 404)
    mt = {"html": "text/html", "svg": "image/svg+xml"}.get(a["kind"], "text/plain")
    h = {"Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff"}
    return Response(a["content"], media_type=mt + "; charset=utf-8", headers=h)

async def art_view(request: Request):
    a = _art(request)
    if not a:
        return err("not found", 404)
    aid, v = a["id"], a["version"]
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    page = (f"<!doctype html><meta charset=utf-8><title>{esc(a['title'])}</title>"
            f"<body style='margin:0;font:14px system-ui'><div style='padding:8px 12px;border-bottom:1px solid #ccc'>"
            f"{esc(a['title'])} · v{v} · {esc(a['kind'])}</div>"
            f"<iframe sandbox='allow-scripts' src='/api/artifacts/{aid}/raw?v={v}' "
            f"style='border:0;width:100%;height:calc(100vh - 38px)'></iframe></body>")
    return HTMLResponse(page)

async def health(request: Request):
    return JSONResponse({"status": "ok", "rag_chunks": S.rag.count(), "upstreams": list(S.router.ups),
                         "tools_enabled": S.cfg.get("tools_enabled", False)})

async def index(request: Request):
    return FileResponse(settings.ROOT / "frontend" / "index.html")

async def favicon(request: Request):
    return FileResponse(settings.ROOT / "frontend" / "favicon.svg", media_type="image/svg+xml")

def build() -> Starlette:
    return Starlette(routes=[
        Route("/", index), Route("/favicon.ico", favicon), Route("/health", health),
        Route("/v1/models", models), Route("/v1/chat/completions", chat, methods=["POST"]),
        Route("/api/upload", upload, methods=["POST"]), Route("/api/rag/search", rag_search),
        Route("/api/skills", skills_list), Route("/api/tools/run", tool_run, methods=["POST"]),
        Route("/api/agent/run", agent_run, methods=["POST"]), Route("/api/agents", agents_list),
        Route("/api/memory", mem_list), Route("/api/memory", mem_save, methods=["POST"]),
        Route("/api/memory/{mid:int}", mem_delete, methods=["DELETE"]), Route("/panel", panel),
        Route("/api/history", history), Route("/api/sessions", sessions),
        Route("/api/artifacts", art_create, methods=["POST"]), Route("/api/artifacts/list", art_list),
        Route("/api/artifacts/{aid}", art_get), Route("/api/artifacts/{aid}/raw", art_raw),
        Route("/artifacts/{aid}", art_view),
        Mount("/chat-assets", StaticFiles(directory=settings.ROOT / "frontend" / "chat-assets")),
        *ORCH_ROUTES,
    ])
