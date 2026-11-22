/**
 * Module 14: Skills Engine
 *
 * A skill is a reusable package of expert instructions (Markdown with YAML-ish
 * frontmatter: name, description, triggers). Skills are stored in the
 * database, can be imported from SKILL.md text or a directory, and are
 * surfaced to agents in two ways:
 *  - a short catalogue (name + description) in the system prompt, and
 *  - the `load_skill` tool, which returns the full body on demand.
 * Relevance matching ranks skills against a task by trigger/keyword overlap.
 */
import { promises as fsp, existsSync } from 'node:fs'
import path from 'node:path'
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js'

export interface Skill {
  id: string
  name: string
  description: string
  body: string
  triggers: string[]
  source: string | null
  enabled: boolean
  builtin: boolean
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  name: string
  description: string
  body: string
  triggers: string
  source: string | null
  enabled: number
  builtin: number
  created_at: string
  updated_at: string
}

const toSkill = (r: Row): Skill => ({
  id: r.id,
  name: r.name,
  description: r.description,
  body: r.body,
  triggers: parseJson(r.triggers, []),
  source: r.source,
  enabled: !!r.enabled,
  builtin: !!r.builtin,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export function parseSkillMarkdown(text: string): { name: string; description: string; triggers: string[]; body: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) throw new ValidationError('SKILL.md must start with a frontmatter block (--- name: ... description: ... ---)')
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/)
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, '')
  }
  if (!meta.name) throw new ValidationError('Skill frontmatter requires a name')
  if (!meta.description) throw new ValidationError('Skill frontmatter requires a description')
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(meta.name)) throw new ValidationError('Skill name must be lowercase letters, digits and dashes')
  const triggers = (meta.triggers ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter(Boolean)
  return { name: meta.name, description: meta.description, triggers, body: m[2]!.trim() }
}

const BUILTIN_SKILLS = [
  `---
name: code-review-checklist
description: Systematic checklist for reviewing code changes for correctness, security and maintainability.
triggers: review, pull request, pr, audit, diff
---
# Code review checklist

1. **Understand intent** — read the task/PR description and the full diff (git_diff) before judging lines.
2. **Correctness** — boundary conditions, null/undefined handling, error paths, off-by-one, async ordering, resource cleanup.
3. **Security** — input validation, injection (SQL, shell, path traversal), authn/authz checks, secrets in code, unsafe deserialization, XSS.
4. **Concurrency & state** — races, shared mutable state, idempotency of retries.
5. **Performance** — N+1 queries, unbounded loops or memory, blocking I/O on hot paths.
6. **Tests** — do tests cover the new behavior and failure modes? Run them.
7. **Maintainability** — naming, duplication, function size, clear module boundaries.
8. **Report** — for each issue: file:line, severity (critical/high/medium/low), why it matters, concrete fix. Separate must-fix from suggestions.`,
  `---
name: test-driven-fix
description: Reproduce a bug with a failing test first, then fix it and prove the fix.
triggers: bug, fix, regression, failing, broken, error
---
# Test-driven bug fixing

1. Reproduce the bug: run the failing command or write a minimal failing test that captures the reported behavior.
2. Confirm the test fails for the reported reason (read the assertion message).
3. Locate the root cause using the stack trace (debug_error) and code reading; avoid patching symptoms.
4. Make the smallest change that fixes the root cause.
5. Run the new test, then the full suite (run_tests). Nothing previously passing may fail.
6. Report the cause, the fix, and the evidence (test names and results).`,
  `---
name: safe-refactoring
description: Refactor code in small behavior-preserving steps with continuous verification.
triggers: refactor, cleanup, restructure, rename, extract, simplify
---
# Safe refactoring

- Establish a green baseline: run the tests before touching anything.
- Change one thing at a time (rename, extract function, move module), running tests after each step.
- Keep public APIs stable unless explicitly asked; if you must change them, update every call site (use find_references).
- Do not mix refactoring with behavior changes in the same step.
- Finish with a summary of structural changes and test results.`,
  `---
name: git-workflow
description: Clean git hygiene for agent-made changes — branches, focused commits and messages.
triggers: git, commit, branch, push, merge
---
# Git workflow

- Check git_status before and after changes; never commit unrelated files.
- Work on a feature branch (git_checkout with create) when the task is non-trivial.
- Stage only files you intentionally changed.
- Commit messages: imperative subject <= 72 chars ("Add retry to webhook sender"), body explains why.
- The commit tool blocks secrets automatically; if blocked, remove the secret instead of overriding.
- Never force-push or rewrite shared history.`,
  `---
name: api-design
description: Design consistent, secure REST/JSON APIs.
triggers: api, endpoint, rest, route, http
---
# API design guidelines

- Resource-oriented URLs, plural nouns, HTTP verbs for actions; consistent casing.
- Validate every input at the boundary; return 400 with field-level messages.
- Authenticate every route; authorize per resource; never trust client-supplied ownership.
- Use proper status codes (201 created, 204 no content, 404, 409 conflict, 422/400 validation).
- Paginate list endpoints; bound limits.
- Document request/response shapes and add tests for success and failure paths.`,
  `---
name: performance-investigation
description: Measure-first approach for finding and fixing performance problems.
triggers: slow, performance, latency, memory, optimize, cpu
---
# Performance investigation

1. Define the metric and reproduce it with a measurable command.
2. Measure before changing anything; identify the hot path with evidence (profiling output, timing logs).
3. Fix the biggest bottleneck first (algorithmic complexity, I/O, N+1 queries) before micro-optimizations.
4. Re-measure and report before/after numbers.`,
]

export class SkillsEngine {
  constructor(private readonly db: Database) {}

  seed(): number {
    let n = 0
    for (const text of BUILTIN_SKILLS) {
      const s = parseSkillMarkdown(text)
      if (this.db.get('SELECT id FROM skills WHERE name = ?', [s.name])) continue
      const ts = now()
      this.db.insert('skills', { id: newId('skill'), name: s.name, description: s.description, body: s.body, triggers: JSON.stringify(s.triggers), source: 'builtin', enabled: 1, builtin: 1, created_at: ts, updated_at: ts })
      n++
    }
    return n
  }

  list(onlyEnabled = false): Skill[] {
    return this.db.all<Row>(`SELECT * FROM skills ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY name`).map(toSkill)
  }

  get(idOrName: string): Skill {
    const r = this.db.get<Row>('SELECT * FROM skills WHERE id = ? OR name = ?', [idOrName, idOrName])
    if (!r) throw new NotFoundError('Skill')
    return toSkill(r)
  }

  install(markdown: string, source = 'user', overwrite = false): Skill {
    const s = parseSkillMarkdown(markdown)
    const existing = this.db.get<Row>('SELECT * FROM skills WHERE name = ?', [s.name])
    const ts = now()
    if (existing) {
      if (!overwrite) throw new ConflictError(`Skill '${s.name}' already exists`)
      this.db.update('skills', existing.id, { description: s.description, body: s.body, triggers: JSON.stringify(s.triggers), source, updated_at: ts })
      return this.get(existing.id)
    }
    const id = newId('skill')
    this.db.insert('skills', { id, name: s.name, description: s.description, body: s.body, triggers: JSON.stringify(s.triggers), source, enabled: 1, builtin: 0, created_at: ts, updated_at: ts })
    return this.get(id)
  }

  /** Install every SKILL.md found in a directory (one level of subdirectories or *.md files). */
  async installFromDirectory(dir: string): Promise<Skill[]> {
    const out: Skill[] = []
    if (!existsSync(dir)) throw new NotFoundError(`Directory '${dir}'`)
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const file = e.isDirectory() ? path.join(dir, e.name, 'SKILL.md') : e.name.endsWith('.md') ? path.join(dir, e.name) : null
      if (!file || !existsSync(file)) continue
      out.push(this.install(await fsp.readFile(file, 'utf8'), `dir:${dir}`, true))
    }
    return out
  }

  setEnabled(id: string, enabled: boolean): Skill {
    const s = this.get(id)
    this.db.update('skills', s.id, { enabled: enabled ? 1 : 0, updated_at: now() })
    return this.get(s.id)
  }

  update(id: string, markdown: string): Skill {
    const s = this.get(id)
    const parsed = parseSkillMarkdown(markdown)
    this.db.update('skills', s.id, { name: parsed.name, description: parsed.description, body: parsed.body, triggers: JSON.stringify(parsed.triggers), updated_at: now() })
    return this.get(s.id)
  }

  delete(id: string): void {
    const s = this.get(id)
    this.db.run('DELETE FROM skills WHERE id = ?', [s.id])
  }

  toMarkdown(s: Skill): string {
    return `---\nname: ${s.name}\ndescription: ${s.description}\ntriggers: ${s.triggers.join(', ')}\n---\n\n${s.body}\n`
  }

  /** Rank enabled skills by relevance to a task text. */
  match(text: string, limit = 3, restrictTo?: string[]): Array<{ skill: Skill; score: number }> {
    const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
    const lower = text.toLowerCase()
    return this.list(true)
      .filter((s) => !restrictTo?.length || restrictTo.includes(s.name))
      .map((skill) => {
        let score = 0
        for (const t of skill.triggers) if (lower.includes(t)) score += 3
        for (const w of skill.description.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 3 && words.has(w)) score += 1
        return { skill, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  catalogue(restrictTo?: string[]): string {
    const skills = this.list(true).filter((s) => !restrictTo?.length || restrictTo.includes(s.name))
    if (!skills.length) return ''
    return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
  }
}
