"""Platform settings: config/platform.json overlaid by environment variables."""
from __future__ import annotations
import json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORAGE = Path(os.environ.get("UP_STORAGE", ROOT / "storage")).resolve()
VENDOR_RAG = ROOT / "vendor" / "knowledge_rag"

DEFAULTS = {
    "upstreams": [],          # [{"name","base_url","api_key_env","models":["*"]}]
    "default_model": None,
    "rag": {"enabled": True, "top_k": 4, "max_chars": 3000},
    "sandbox": {"allow": ["python3", "ls", "cat", "echo", "grep", "wc", "head", "tail"],
                "timeout": 10, "mem_mb": 256, "max_output": 20000,
                "backend": "local", "docker_image": "unified-sandbox:latest", "cpus": 1},
    "tools_enabled": False,
    "max_upload_bytes": 20 * 1024 * 1024,
}

def load() -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    p = Path(os.environ.get("UP_CONFIG", ROOT / "config" / "platform.json"))
    if p.exists():
        user = json.loads(p.read_text("utf-8"))
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    if os.environ.get("UP_TOOLS") == "1":
        cfg["tools_enabled"] = True
    return cfg

def setup_rag_path() -> None:
    """Make the vendored knowledge-rag package importable as `mcp_server`."""
    os.environ.setdefault("KNOWLEDGE_RAG_DIR", str(STORAGE / "rag"))
    (STORAGE / "rag").mkdir(parents=True, exist_ok=True)
    if str(VENDOR_RAG) not in sys.path:
        sys.path.insert(0, str(VENDOR_RAG))
