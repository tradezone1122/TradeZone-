import json, socket, sys, threading, time
from pathlib import Path
import pytest, requests, uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def serve(app):
    port = free_port()
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    t = threading.Thread(target=srv.run, daemon=True); t.start()
    for _ in range(100):
        if srv.started: break
        time.sleep(0.05)
    return srv, f"http://127.0.0.1:{port}"

def mock_upstream():
    """TEST FIXTURE ONLY: a fake OpenAI-compatible server that echoes the last user message
    and reports whether a system (RAG) message was injected."""
    async def models(r):
        return JSONResponse({"data": [{"id": "echo-1", "object": "model"}]})
    async def chat(r):
        b = await r.json()
        msgs = b["messages"]
        sys_ctx = next((m["content"] for m in msgs if m["role"] == "system"), "")
        if b.get("tools") is not None:
            # TEST FIXTURE: scripted tool-calling. "CALL:<tool>:<json>" in the task triggers one call.
            if msgs[-1]["role"] == "tool":
                if "LOOP" not in msgs[1]["content"]:
                    return JSONResponse({"choices": [{"message": {"role": "assistant", "content": "final:" + msgs[-1]["content"][:300]}}]})
            import re as _re
            m = _re.search(r"CALL:(\w+):(\{.*\})", msgs[1]["content"])
            if m:
                tc = {"id": "c1", "type": "function", "function": {"name": m.group(1), "arguments": m.group(2)}}
                return JSONResponse({"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [tc]}}]})
            return JSONResponse({"choices": [{"message": {"role": "assistant", "content": "plain:" + msgs[1]["content"] + "|sys:" + msgs[0]["content"][-120:]}}]})
        reply = f"echo:{msgs[-1]['content']}|sys:{sys_ctx[:200]}|model:{b.get('model')}"
        if not b.get("stream"):
            return JSONResponse({"choices": [{"message": {"role": "assistant", "content": reply}}]})
        def gen():
            for w in [reply[:10], reply[10:]]:
                yield f"data: {json.dumps({'choices':[{'delta':{'content':w}}]})}\n\n".encode()
            yield b"data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")
    return Starlette(routes=[Route("/v1/models", models), Route("/v1/chat/completions", chat, methods=["POST"])])

@pytest.fixture(scope="session")
def upstream():
    srv, url = serve(mock_upstream()); yield url; srv.should_exit = True

@pytest.fixture()
def platform(tmp_path, monkeypatch, upstream):
    monkeypatch.setenv("UP_STORAGE", str(tmp_path))
    import importlib
    from backend import settings, store
    importlib.reload(settings)
    store.reset_for_tests()
    store.STORAGE = settings.STORAGE
    import backend.sandbox as sb; sb.settings = settings
    from backend import app as A
    A.settings = settings
    cfg = settings.load()
    cfg["upstreams"] = [{"name": "mock", "base_url": upstream + "/v1", "models": ["*"]}]
    cfg["default_model"] = "echo-1"
    cfg["tools_enabled"] = True
    from backend.rag import Rag
    A.init(cfg, Rag(tmp_path / "rag"))
    srv, url = serve(A.build())
    yield url, A
    srv.should_exit = True
