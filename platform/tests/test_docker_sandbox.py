"""Docker backend tests use a FAKE `docker` executable that records its arguments.
They verify the command we build and error handling; they do NOT prove isolation on a real daemon."""
import json, os, stat, requests, pytest
from backend import sandbox

FAKE = """#!/usr/bin/env python3
import sys, json, os, time
log = os.environ["FAKE_DOCKER_LOG"]
open(log, "a").write(json.dumps(sys.argv[1:]) + "\\n")
mode = os.environ.get("FAKE_DOCKER_MODE", "ok")
if sys.argv[1] == "kill": sys.exit(0)
if mode == "nodaemon":
    sys.stderr.write("failed to connect to the docker API at unix:///var/run/docker.sock"); sys.exit(1)
if mode == "hang": time.sleep(30)
print("ran-in-container")
"""

@pytest.fixture()
def fake_docker(tmp_path, monkeypatch):
    d = tmp_path / "bin"; d.mkdir()
    f = d / "docker"; f.write_text(FAKE); f.chmod(f.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "docker.log"
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_DOCKER_LOG", str(log))
    return log

def cfg(**kw):
    c = {"allow": ["python3", "echo"], "timeout": 2, "mem_mb": 128, "max_output": 1000, "backend": "docker"}
    c.update(kw); return c

def lines(log): return [json.loads(l) for l in log.read_text().splitlines()]

def test_docker_command_is_locked_down(fake_docker, tmp_path, monkeypatch):
    monkeypatch.setenv("UP_STORAGE", str(tmp_path / "st"))
    import importlib; from backend import settings; importlib.reload(settings); sandbox.settings = settings
    r = sandbox.run(["echo", "hi"], cfg())
    assert r["exit_code"] == 0 and "ran-in-container" in r["stdout"]
    a = lines(fake_docker)[0]
    j = " ".join(a)
    for must in ["--network none", "--read-only", "--cap-drop ALL", "no-new-privileges", "--pids-limit 64",
                 "--memory 128m", "--user 1000:1000"]:
        assert must in j, must
    assert a[-2:] == ["echo", "hi"] and "unified-sandbox:latest" in a
    mounts = [a[i + 1] for i, x in enumerate(a) if x == "-v"]
    assert len(mounts) == 1 and mounts[0].endswith(":/workspace:rw")
    assert "--privileged" not in a and "/var/run/docker.sock" not in j

def test_allowlist_still_enforced_in_docker_mode(fake_docker):
    with pytest.raises(sandbox.SandboxError):
        sandbox.run(["rm", "-rf", "/"], cfg())
    assert not fake_docker.exists()       # docker never invoked for a denied command

def test_no_daemon_is_error_not_silent_local_fallback(fake_docker, monkeypatch):
    monkeypatch.setenv("FAKE_DOCKER_MODE", "nodaemon")
    with pytest.raises(sandbox.SandboxError, match="unavailable"):
        sandbox.run(["echo", "x"], cfg())

def test_docker_timeout_kills_container(fake_docker, monkeypatch):
    monkeypatch.setenv("FAKE_DOCKER_MODE", "hang")
    r = sandbox.run(["echo", "x"], cfg(timeout=1))
    assert r["timed_out"] is True
    assert any(l[0] == "kill" for l in lines(fake_docker))

def test_missing_docker_cli(monkeypatch):
    monkeypatch.setenv("PATH", "/nonexistent")
    with pytest.raises(sandbox.SandboxError, match="not installed"):
        sandbox._run_docker(["echo"], cfg(), None)

def test_api_returns_403_when_docker_unavailable(platform, fake_docker, monkeypatch):
    url, A = platform
    monkeypatch.setenv("FAKE_DOCKER_MODE", "nodaemon")
    A.S.cfg["sandbox"]["backend"] = "docker"
    r = requests.post(url + "/api/tools/run", json={"argv": ["echo", "x"]}, headers={"X-Admin-Token": A.S.token})
    assert r.status_code == 403 and "unavailable" in r.json()["error"]["message"]
