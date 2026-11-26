import json, requests
from backend import memory

def run(url, agent, task, headers=None):
    return requests.post(url + "/api/agent/run", json={"agent": agent, "task": task}, headers=headers or {})

def H(A): return {"X-Admin-Token": A.S.token}

def test_agent_plain_answer(platform):
    url, A = platform
    r = run(url, "researcher", "hello there", H(A))
    assert r.status_code == 200 and r.json()["answer"].startswith("plain:hello there")

def test_agent_requires_token_when_tools_enabled(platform):
    url, A = platform
    assert run(url, "assistant", "x").status_code == 401
    A.S.cfg["tools_enabled"] = False
    assert run(url, "assistant", "x").status_code == 200

def test_unknown_agent_and_bad_body(platform):
    url, A = platform
    assert run(url, "nobody", "x", H(A)).status_code == 404
    assert requests.post(url + "/api/agent/run", json={}, headers=H(A)).status_code == 400

def test_agent_tool_memory_roundtrip(platform):
    url, A = platform
    r = run(url, "assistant", 'CALL:memory_save:{"content":"Ahmed prefers Python over Java"}', H(A)).json()
    assert r["trace"][0]["tool"] == "memory_save" and r["trace"][0]["ok"]
    assert any("Python" in m["content"] for m in requests.get(url + "/api/memory").json()["memories"])
    r2 = run(url, "researcher", 'CALL:memory_recall:{"query":"Ahmed Python"}', H(A)).json()
    assert "prefers Python" in r2["answer"]

def test_memory_injected_into_agent_prompt(platform):
    url, A = platform
    memory.save("The deploy password hint is turquoise")
    r = run(url, "researcher", "what is the turquoise hint", H(A)).json()
    assert "turquoise" in r["answer"]            # system prompt tail echoed by the mock contains the memory

def test_agent_rag_tool(platform):
    url, A = platform
    requests.post(url + "/api/upload", params={"filename": "k.md"}, data=b"# K\nThe Quibbler engine runs at nine hertz.\n")
    r = run(url, "researcher", 'CALL:rag_search:{"query":"Quibbler hertz"}', H(A)).json()
    assert "k.md" in r["answer"]

def test_agent_artifact_tool_and_view(platform):
    url, A = platform
    r = run(url, "coder", 'CALL:artifact_create:{"title":"T","kind":"html","content":"<b>hi</b>"}', H(A)).json()
    aid = json.loads(r["answer"][len("final:"):])["id"]
    assert "<b>hi</b>" in requests.get(f"{url}/api/artifacts/{aid}/raw").text

def test_agent_shell_tool_sandboxed(platform):
    url, A = platform
    ok = run(url, "coder", 'CALL:shell:{"argv":["echo","agent-ran"]}', H(A)).json()
    assert "agent-ran" in ok["answer"]
    bad = run(url, "coder", 'CALL:shell:{"argv":["rm","-rf","/"]}', H(A)).json()
    assert "not allowed" in bad["answer"] and bad["trace"][0]["ok"] is False

def test_agent_cannot_use_tool_outside_allowlist(platform):
    url, A = platform
    r = run(url, "researcher", 'CALL:shell:{"argv":["echo","x"]}', H(A)).json()
    assert "may not use tool" in r["answer"]

def test_bad_tool_arguments_are_returned_to_model_not_crash(platform):
    url, A = platform
    r = run(url, "assistant", 'CALL:rag_search:{"wrong":1}', H(A))
    assert r.status_code == 200 and "error:" in r.json()["answer"]

def test_step_limit(platform):
    url, A = platform
    r = run(url, "assistant", 'LOOP CALL:memory_recall:{"query":"zzz"}', H(A)).json()
    assert "step limit" in r["answer"] and r["steps"] == 6

def test_delegation_agent_to_agent(platform):
    url, A = platform
    memory.save("Cairo is the capital of Egypt")
    task = 'CALL:delegate:{"agent":"researcher","task":"CALL:memory_recall:{\\"query\\":\\"capital Egypt\\"}"}'
    r = run(url, "lead", task, H(A)).json()
    assert "Cairo" in r["answer"]
    tools = [(t["agent"], t["tool"], t["depth"]) for t in r["trace"]]
    assert ("researcher", "memory_recall", 1) in tools and ("lead", "delegate", 0) in tools

def test_delegation_depth_limit(platform):
    url, A = platform
    A.S.cfg["agents"] = {"lead": {"prompt": "p", "tools": ["delegate"]}}
    task = 'CALL:delegate:{"agent":"lead","task":"CALL:delegate:{\\"agent\\":\\"lead\\",\\"task\\":\\"CALL:delegate:{\\\\\\"agent\\\\\\":\\\\\\"lead\\\\\\",\\\\\\"task\\\\\\":\\\\\\"x\\\\\\"}\\"}"}'
    r = run(url, "lead", task, H(A)).json()
    assert r["steps"] >= 1 and "max delegation depth" in json.dumps(r)

def test_agent_run_persists_session(platform):
    url, A = platform
    requests.post(url + "/api/agent/run", json={"agent": "researcher", "task": "remember me", "session": "agent-s"}, headers=H(A))
    h = requests.get(url + "/api/history", params={"session": "agent-s"}).json()["messages"]
    assert [m["role"] for m in h] == ["user", "assistant"]

def test_memory_api_crud_and_validation(platform):
    url, _ = platform
    r = requests.post(url + "/api/memory", json={"content": "fact one"}); assert r.status_code == 201
    mid = r.json()["id"]
    assert requests.post(url + "/api/memory", json={"content": "fact one"}).json()["id"] == mid   # dedupe
    assert requests.post(url + "/api/memory", json={"content": ""}).status_code == 400
    assert requests.delete(f"{url}/api/memory/{mid}").status_code == 200
    assert requests.delete(f"{url}/api/memory/{mid}").status_code == 404

def test_memory_survives_restart(platform):
    url, _ = platform
    from backend import store
    requests.post(url + "/api/memory", json={"content": "durable fact"})
    store.reset_for_tests()
    assert any(m["content"] == "durable fact" for m in requests.get(url + "/api/memory").json()["memories"])

def test_panel_served_and_agents_listed(platform):
    url, _ = platform
    assert "Run an agent" in requests.get(url + "/panel").text
    assert {a["name"] for a in requests.get(url + "/api/agents").json()["agents"]} >= {"assistant", "lead", "researcher", "coder"}
    assert "/panel" in requests.get(url + "/").text

def test_upstream_failure_in_agent_is_502(platform):
    url, A = platform
    A.S.router.ups = {"dead": {"name": "dead", "base_url": "http://127.0.0.1:9/v1", "models": ["*"]}}
    assert run(url, "assistant", "x", H(A)).status_code == 502
