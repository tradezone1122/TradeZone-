import json, time
import requests, pytest
from backend import store

def test_health_and_ui(platform):
    url, A = platform
    assert requests.get(url + "/health").json()["status"] == "ok"
    r = requests.get(url + "/")
    assert r.status_code == 200 and "<title>" in r.text
    assert requests.get(url + "/chat-assets/markdown-it-15.0.2.min.js").status_code == 200

def test_models_aggregates_upstream(platform):
    url, _ = platform
    ids = [m["id"] for m in requests.get(url + "/v1/models").json()["data"]]
    assert ids == ["mock/echo-1"]

def test_chat_nonstream_routes_and_logs(platform):
    url, _ = platform
    r = requests.post(url + "/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]},
                      headers={"X-Session-Id": "s1"})
    assert r.status_code == 200
    assert "echo:hi" in r.json()["choices"][0]["message"]["content"]
    h = requests.get(url + "/api/history", params={"session": "s1"}).json()["messages"]
    assert [m["role"] for m in h] == ["user", "assistant"]

def test_chat_stream_sse_and_persist_after_restart(platform):
    url, _ = platform
    r = requests.post(url + "/v1/chat/completions", stream=True, headers={"X-Session-Id": "s2"},
                      json={"messages": [{"role": "user", "content": "stream me"}], "stream": True})
    body = b"".join(r.iter_content(None)).decode()
    assert "data: [DONE]" in body and "echo:stream me" in body.replace('"},{"', "").replace('\\"', '"') or "echo" in body
    store.reset_for_tests()          # simulate process restart: reopen db from disk
    h = requests.get(url + "/api/history", params={"session": "s2"}).json()["messages"]
    assert h[-1]["role"] == "assistant" and "echo:stream me" in h[-1]["content"]

def test_session_isolation(platform):
    url, _ = platform
    for s, t in (("a", "alpha"), ("b", "beta")):
        requests.post(url + "/v1/chat/completions", headers={"X-Session-Id": s},
                      json={"messages": [{"role": "user", "content": t}]})
    ha = requests.get(url + "/api/history", params={"session": "a"}).json()["messages"]
    assert all("beta" not in m["content"] for m in ha)

def test_upload_rag_retrieval_and_injection(platform):
    url, _ = platform
    doc = b"# Notes\nThe Zorblax protocol uses seventeen quantum widgets.\n"
    r = requests.post(url + "/api/upload", params={"filename": "notes.md"}, data=doc)
    assert r.status_code == 200 and r.json()["chunks_indexed"] >= 1
    hits = requests.get(url + "/api/rag/search", params={"q": "Zorblax widgets"}).json()["hits"]
    assert hits and hits[0]["filename"] == "notes.md"
    c = requests.post(url + "/v1/chat/completions",
                      json={"messages": [{"role": "user", "content": "What is Zorblax?"}]}).json()
    assert "notes.md" in c["choices"][0]["message"]["content"]   # system context reached upstream

def test_upload_rejects_bad_names_and_traversal(platform):
    url, _ = platform
    assert requests.post(url + "/api/upload", data=b"x").status_code == 400
    assert requests.post(url + "/api/upload", params={"filename": "../../evil.md"}, data=b"# x\nhi there\n").status_code == 400
    r = requests.post(url + "/api/upload", params={"filename": "a/../b.md"}, data=b"# x\nhi there\n")
    assert r.status_code == 200 and "/" not in r.json()["filename"]
    from backend import settings
    assert (settings.STORAGE / "uploads" / r.json()["filename"]).exists()
    assert not (settings.STORAGE.parent / "evil.md").exists()

def test_upload_size_limit(platform):
    url, A = platform
    A.S.cfg["max_upload_bytes"] = 100
    assert requests.post(url + "/api/upload", params={"filename": "big.txt"}, data=b"a" * 500).status_code == 413

def test_skills_index(platform):
    url, _ = platform
    s = requests.get(url + "/api/skills").json()["skills"]
    assert len(s) >= 10 and all(x["name"] for x in s)

def test_tools_require_token_and_allowlist(platform):
    url, A = platform
    assert requests.post(url + "/api/tools/run", json={"argv": ["echo", "x"]}).status_code == 401
    h = {"X-Admin-Token": A.S.token}
    ok = requests.post(url + "/api/tools/run", json={"argv": ["echo", "hello"]}, headers=h).json()
    assert ok["exit_code"] == 0 and ok["stdout"].strip() == "hello"
    for bad in (["rm", "-rf", "/"], ["/bin/ls"], ["bash", "-c", "id"], []):
        assert requests.post(url + "/api/tools/run", json={"argv": bad}, headers=h).status_code == 403

def test_tool_timeout(platform):
    url, A = platform
    A.S.cfg["sandbox"]["timeout"] = 1
    r = requests.post(url + "/api/tools/run", headers={"X-Admin-Token": A.S.token},
                      json={"argv": ["python3", "-c", "import time; time.sleep(5)"]}).json()
    assert r["timed_out"] is True

def test_tools_disabled_by_default(platform):
    url, A = platform
    A.S.cfg["tools_enabled"] = False
    assert requests.post(url + "/api/tools/run", json={"argv": ["echo", "x"]}).status_code == 403

def test_artifact_versions_and_sandbox_headers(platform):
    url, _ = platform
    r = requests.post(url + "/api/artifacts", json={"title": "Demo", "kind": "html", "content": "<h1>v1</h1>"})
    assert r.status_code == 201
    aid = r.json()["id"]
    r2 = requests.post(url + "/api/artifacts", json={"id": aid, "title": "Demo", "kind": "html", "content": "<h1>v2</h1>"})
    assert r2.json()["version"] == 2
    raw = requests.get(f"{url}/api/artifacts/{aid}/raw")
    assert "<h1>v2</h1>" in raw.text and "sandbox" in raw.headers["content-security-policy"]
    assert "<h1>v1</h1>" in requests.get(f"{url}/api/artifacts/{aid}/raw", params={"v": 1}).text
    view = requests.get(f"{url}/artifacts/{aid}").text
    assert "<iframe sandbox=" in view
    assert requests.get(url + "/api/artifacts/list").json()["artifacts"][0]["version"] == 2

def test_artifact_validation(platform):
    url, _ = platform
    assert requests.post(url + "/api/artifacts", json={"title": "x", "kind": "exe", "content": "x"}).status_code == 400
    assert requests.get(url + "/api/artifacts/nope").status_code == 404

def test_chat_validation_and_missing_upstream(platform):
    url, A = platform
    assert requests.post(url + "/v1/chat/completions", json={"messages": []}).status_code == 400
    assert requests.post(url + "/v1/chat/completions", data="not json").status_code == 400
    A.S.router.ups = {}
    r = requests.post(url + "/v1/chat/completions", json={"messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 503

def test_upstream_down_is_502(platform):
    url, A = platform
    A.S.router.ups = {"dead": {"name": "dead", "base_url": "http://127.0.0.1:9/v1", "models": ["*"]}}
    r = requests.post(url + "/v1/chat/completions", json={"messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 502
    assert "unreachable" in r.json()["error"]["message"]
