"""Tests for backend/skills_engine.py"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.skills_engine import SkillRegistry, Skill


@pytest.fixture
def skill_dir(tmp_path):
    """Create a temporary skills directory with 3 test skills."""
    skills = tmp_path / "skills"
    skills.mkdir()

    # skill with front-matter
    s1 = skills / "test-skill"
    s1.mkdir()
    (s1 / "SKILL.md").write_text(
        "---\nname: test-skill\ndescription: A test skill\n---\n\n# Do this\nDo exactly this."
    )

    # skill with multi-line description
    s2 = skills / "code-review"
    s2.mkdir()
    (s2 / "SKILL.md").write_text(
        '---\nname: code-review\ndescription: >\n  Review code for bugs\n  and security issues.\n---\n\nReview carefully.'
    )

    # skill without front-matter
    s3 = skills / "plain-skill"
    s3.mkdir()
    (s3 / "SKILL.md").write_text("Just a plain prompt without front-matter.")

    return tmp_path


@pytest.fixture
def registry(skill_dir):
    return SkillRegistry(skill_dir / "skills")


# ── load_all / list ──────────────────────────────────────────────────────────

def test_list_returns_all(registry):
    items = registry.list()
    names = [i["name"] for i in items]
    assert len(items) == 3
    assert "test-skill" in names
    assert "plain-skill" in names


def test_list_has_description(registry):
    items = {i["name"]: i for i in registry.list()}
    assert items["test-skill"]["description"] == "A test skill"


def test_plain_skill_loads(registry):
    skill = registry.get("plain-skill")
    assert skill is not None
    assert "plain prompt" in skill.prompt


# ── get ──────────────────────────────────────────────────────────────────────

def test_get_existing(registry):
    s = registry.get("test-skill")
    assert s is not None
    assert s.name == "test-skill"
    assert "Do exactly this" in s.prompt


def test_get_missing_returns_none(registry):
    assert registry.get("nonexistent") is None


# ── inject ───────────────────────────────────────────────────────────────────

def test_inject_prepends_system(registry):
    messages = [{"role": "user", "content": "hello"}]
    out = registry.inject("test-skill", messages)
    assert out[0]["role"] == "system"
    assert "Do exactly this" in out[0]["content"]
    assert out[1]["role"] == "user"


def test_inject_merges_existing_system(registry):
    messages = [
        {"role": "system", "content": "existing sys"},
        {"role": "user", "content": "hi"},
    ]
    out = registry.inject("test-skill", messages)
    assert out[0]["role"] == "system"
    assert "existing sys" in out[0]["content"]
    assert "Do exactly this" in out[0]["content"]
    assert len(out) == 2


def test_inject_unknown_skill_noop(registry):
    messages = [{"role": "user", "content": "hi"}]
    out = registry.inject("does-not-exist", messages)
    assert out == messages


def test_inject_does_not_mutate_original(registry):
    messages = [{"role": "user", "content": "hi"}]
    original = list(messages)
    registry.inject("test-skill", messages)
    assert messages == original


# ── empty directory ───────────────────────────────────────────────────────────

def test_empty_skills_dir(tmp_path):
    empty = tmp_path / "empty_skills"
    empty.mkdir()
    reg = SkillRegistry(empty)
    assert reg.list() == []
    assert reg.get("x") is None


def test_missing_skills_dir(tmp_path):
    reg = SkillRegistry(tmp_path / "nonexistent")
    assert reg.list() == []
