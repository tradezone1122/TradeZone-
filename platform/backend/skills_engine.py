"""
Skills Engine — loads and executes SKILL.md prompt skills.
Skills live in platform/skills/<name>/SKILL.md
Each skill is a system-prompt template injected into the agent loop.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"


# ── Skill dataclass ──────────────────────────────────────────────────────────

class Skill:
    def __init__(self, name: str, description: str, prompt: str, path: Path):
        self.name        = name
        self.description = description
        self.prompt      = prompt
        self.path        = path

    def to_dict(self) -> dict:
        return {"name": self.name, "description": self.description}


# ── Registry ─────────────────────────────────────────────────────────────────

class SkillRegistry:
    def __init__(self, skills_dir: Path = SKILLS_DIR):
        self._dir   = skills_dir
        self._cache: dict[str, Skill] = {}
        self._loaded = False

    def _parse_skill(self, path: Path) -> Optional[Skill]:
        """Parse SKILL.md — extract YAML front-matter name/description + body."""
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

        name        = path.parent.name
        description = ""
        prompt      = text

        # YAML front-matter between ---
        fm_match = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
        if fm_match:
            fm_text = fm_match.group(1)
            body    = text[fm_match.end():]
            # extract name:
            m = re.search(r"^name:\s*(.+)$", fm_text, re.MULTILINE)
            if m:
                name = m.group(1).strip().strip('"\'')
            # extract description: (may be multi-line with ">")
            m = re.search(r"^description:\s*>?\s*\n?(.*?)(?=\n\w|\Z)", fm_text, re.DOTALL | re.MULTILINE)
            if m:
                description = " ".join(m.group(1).split()).strip()
            prompt = body.strip()

        return Skill(name=name, description=description, prompt=prompt, path=path)

    def load_all(self) -> None:
        if not self._dir.exists():
            self._loaded = True
            return
        for skill_md in self._dir.glob("*/SKILL.md"):
            skill = self._parse_skill(skill_md)
            if skill:
                self._cache[skill_md.parent.name] = skill
        self._loaded = True

    def get(self, skill_id: str) -> Optional[Skill]:
        if not self._loaded:
            self.load_all()
        return self._cache.get(skill_id)

    def list(self) -> list[dict]:
        if not self._loaded:
            self.load_all()
        return [s.to_dict() for s in sorted(self._cache.values(), key=lambda s: s.name)]

    def inject(self, skill_id: str, messages: list[dict]) -> list[dict]:
        """
        Prepend skill system-prompt to messages.
        If a system message already exists, merge skill prompt before it.
        """
        skill = self.get(skill_id)
        if not skill:
            return messages

        sys_msg = {"role": "system", "content": skill.prompt}
        # find existing system message
        for i, m in enumerate(messages):
            if m.get("role") == "system":
                merged = skill.prompt + "\n\n---\n\n" + m["content"]
                updated = list(messages)
                updated[i] = {"role": "system", "content": merged}
                return updated
        return [sys_msg, *messages]


# ── Singleton ────────────────────────────────────────────────────────────────

_registry: Optional[SkillRegistry] = None


def get_registry() -> SkillRegistry:
    global _registry
    if _registry is None:
        _registry = SkillRegistry()
    return _registry
