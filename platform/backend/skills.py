"""Skill index: scans SKILL.md files (YAML frontmatter) under the vendored skills dir."""
from __future__ import annotations
import re
from pathlib import Path

def _frontmatter(text: str) -> dict:
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
    out = {}
    if m:
        for line in m.group(1).splitlines():
            if ":" in line and not line.startswith(" "):
                k, v = line.split(":", 1)
                out[k.strip()] = v.strip().strip("\"'")
    return out

def scan(root: Path) -> list[dict]:
    items = []
    for f in sorted(Path(root).rglob("SKILL.md")):
        fm = _frontmatter(f.read_text("utf-8", errors="replace"))
        items.append({"name": fm.get("name") or f.parent.name,
                      "description": fm.get("description", ""),
                      "path": str(f.relative_to(root)), "source": "knowledge-rag (MIT)"})
    return items

def read(root: Path, name: str) -> str | None:
    for s in scan(root):
        if s["name"] == name:
            return (Path(root) / s["path"]).read_text("utf-8", errors="replace")
    return None
