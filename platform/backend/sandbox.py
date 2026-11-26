"""Command runner with an allowlist, timeout, rlimits and a scrubbed environment.

Backend "local" (default) is NOT A SECURITY SANDBOX. There is no container, namespace or syscall filter:
a permitted interpreter (python3) can still read and write anything the server user can.
It is a guard rail against accidents. Backend "docker" (config sandbox.backend = "docker") runs each command in a
restricted container; it needs a running Docker daemon and the image from sandbox_image/.
"""
from __future__ import annotations
import os, resource, subprocess, shutil
from pathlib import Path
from . import settings

class SandboxError(Exception):
    pass

def workspace() -> Path:
    w = settings.STORAGE / "workspace"
    w.mkdir(parents=True, exist_ok=True)
    return w

def docker_cmd(argv: list[str], cfg: dict, name: str) -> list[str]:
    """Build the `docker run` command: no network, read-only rootfs, all caps dropped,
    no-new-privileges, non-root, pid/memory/cpu limits, only the workspace mounted."""
    return ["docker", "run", "--rm", "-i", "--name", name,
            "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", "64", "--memory", f"{int(cfg['mem_mb'])}m", "--memory-swap", f"{int(cfg['mem_mb'])}m",
            "--cpus", str(cfg.get("cpus", 1)), "--user", "1000:1000",
            "-v", f"{workspace()}:/workspace:rw", "-w", "/workspace",
            cfg.get("docker_image", "unified-sandbox:latest"), *argv]

def _run_docker(argv: list[str], cfg: dict, stdin: str | None) -> dict:
    import uuid
    if not shutil.which("docker"):
        raise SandboxError("docker backend selected but the docker CLI is not installed")
    name = "usb-" + uuid.uuid4().hex[:12]
    try:
        p = subprocess.run(docker_cmd(argv, cfg, name), input=stdin, text=True, capture_output=True,
                           timeout=cfg["timeout"])
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "kill", name], capture_output=True)   # timeout kills the container, not just the client
        return {"exit_code": None, "timed_out": True, "stdout": "", "stderr": "timeout"}
    if p.returncode == 125 or "Cannot connect to the Docker daemon" in p.stderr or "failed to connect to the docker API" in p.stderr:
        raise SandboxError("docker backend unavailable: " + p.stderr.strip()[:200])
    cap = int(cfg["max_output"])
    return {"exit_code": p.returncode, "timed_out": False, "stdout": p.stdout[:cap], "stderr": p.stderr[:cap]}

def run(argv: list[str], cfg: dict, stdin: str | None = None) -> dict:
    if not argv or not all(isinstance(a, str) for a in argv):
        raise SandboxError("argv must be a non-empty list of strings")
    exe = argv[0]
    if exe not in cfg["allow"] or "/" in exe:
        raise SandboxError(f"command not allowed: {exe}")
    if cfg.get("backend", "local") == "docker":
        return _run_docker(argv, cfg, stdin)     # never silently falls back to the weaker local runner
    path = shutil.which(exe)
    if not path:
        raise SandboxError(f"command not found: {exe}")
    mem = int(cfg["mem_mb"]) * 1024 * 1024
    def limits():
        resource.setrlimit(resource.RLIMIT_CPU, (int(cfg["timeout"]) + 1,) * 2)
        resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        resource.setrlimit(resource.RLIMIT_FSIZE, (10 * 1024 * 1024,) * 2)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(workspace()), "LANG": "C.UTF-8"}
    try:
        p = subprocess.run([path, *argv[1:]], cwd=workspace(), env=env, input=stdin, text=True,
                           capture_output=True, timeout=cfg["timeout"], preexec_fn=limits)
    except subprocess.TimeoutExpired:
        return {"exit_code": None, "timed_out": True, "stdout": "", "stderr": "timeout"}
    cap = int(cfg["max_output"])
    return {"exit_code": p.returncode, "timed_out": False,
            "stdout": p.stdout[:cap], "stderr": p.stderr[:cap]}
