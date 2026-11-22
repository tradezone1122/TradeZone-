/**
 * Module 07: Prompt Engineering Engine
 *
 * - Template language: {{var}}, {{var|default}}, {{#if var}}…{{else}}…{{/if}},
 *   {{#each list}}…{{this}}…{{/each}}; variables are auto-discovered.
 * - Template store (CRUD) with built-in engineering templates and an imported
 *   community prompt library (attributed, CC BY-SA 4.0 data file).
 * - System-prompt composition for agents (role + project + skills + memory).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js'

export interface PromptTemplate {
  id: string
  name: string
  category: string
  description: string | null
  template: string
  variables: string[]
  source: string | null
  builtin: boolean
  createdAt: string
  updatedAt: string
}

type Vars = Record<string, unknown>

function lookup(vars: Vars, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), vars)
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  return !!v
}

/** Render a template. Unknown variables render as empty strings (or their default). */
export function renderTemplate(template: string, vars: Vars): string {
  let out = template
  // {{#each list}}...{{/each}} (non-nested)
  out = out.replace(/\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m, key: string, body: string) => {
    const list = lookup(vars, key)
    if (!Array.isArray(list)) return ''
    return list.map((item, index) => renderTemplate(body, { ...vars, this: item, index, ...(item && typeof item === 'object' ? (item as Vars) : {}) })).join('')
  })
  // {{#if x}}...{{else}}...{{/if}} — innermost first, repeat for nesting.
  const ifRe = /\{\{#if\s+(!?)([\w.]+)\}\}((?:(?!\{\{#if)[\s\S])*?)\{\{\/if\}\}/
  for (let guard = 0; guard < 100 && ifRe.test(out); guard++) {
    out = out.replace(ifRe, (_m, neg: string, key: string, body: string) => {
      const [yes, no = ''] = body.split('{{else}}')
      const cond = truthy(lookup(vars, key))
      return (neg ? !cond : cond) ? yes! : no
    })
  }
  out = out.replace(/\{\{\s*([\w.]+)(?:\|([^}]*))?\s*\}\}/g, (_m, key: string, def?: string) => {
    const v = lookup(vars, key)
    if (v === undefined || v === null || v === '') return def ?? ''
    return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)
  })
  return out
}

export function extractVariables(template: string): string[] {
  const vars = new Set<string>()
  const blockKeywords = new Set(['else', 'this', 'index'])
  for (const m of template.matchAll(/\{\{\s*(?:#if\s+!?|#each\s+)?([\w.]+)(?:\|[^}]*)?\s*\}\}/g)) {
    const name = m[1]!.split('.')[0]!
    if (!blockKeywords.has(name)) vars.add(name)
  }
  return [...vars]
}

const BUILTIN_TEMPLATES: Array<{ name: string; category: string; description: string; template: string }> = [
  {
    name: 'implement-feature',
    category: 'engineering',
    description: 'Ask an agent to implement a feature with verification.',
    template: 'Implement the following feature in this project:\n\n{{feature}}\n\n{{#if constraints}}Constraints:\n{{constraints}}\n\n{{/if}}Inspect the existing code first, follow its conventions, add or update tests, run them, and report what you changed and how you verified it.',
  },
  {
    name: 'fix-bug',
    category: 'engineering',
    description: 'Diagnose and fix a bug from a description or error output.',
    template: 'Fix this bug:\n\n{{description}}\n\n{{#if error}}Error output:\n```\n{{error}}\n```\n\n{{/if}}{{#if command}}Reproduce with: `{{command}}`\n\n{{/if}}Find the root cause, fix it, and verify the fix by re-running the failing scenario and the test suite.',
  },
  {
    name: 'write-tests',
    category: 'testing',
    description: 'Generate tests for a file or module.',
    template: 'Write thorough tests for `{{target}}` using the project\'s existing test framework ({{framework|auto-detect}}). Cover normal behavior, edge cases and error paths. Run them and make sure they pass.',
  },
  {
    name: 'code-review',
    category: 'review',
    description: 'Review a change set for correctness, security and maintainability.',
    template: 'Review {{scope|the current uncommitted changes}}. Focus on: {{focus|correctness, security, performance, maintainability}}. For each issue give file:line, severity, explanation and a concrete fix.',
  },
  {
    name: 'explain-code',
    category: 'learning',
    description: 'Explain how a part of the codebase works.',
    template: 'Explain how {{topic}} works in this codebase for a {{audience|developer new to the project}}. Reference the specific files and functions involved, and describe the data flow.',
  },
  {
    name: 'refactor',
    category: 'engineering',
    description: 'Refactor code without changing behavior.',
    template: 'Refactor {{target}} to {{goal}} without changing behavior. Keep the public API stable{{#if allowApiChange}} unless a change is clearly better (explain it){{/if}}. Run the tests before and after.',
  },
  {
    name: 'commit-message',
    category: 'git',
    description: 'Write a conventional commit message for a diff.',
    template: 'Write a concise commit message (imperative mood, <= 72 char subject, optional body explaining why) for this diff:\n\n```diff\n{{diff}}\n```',
  },
  {
    name: 'architecture-doc',
    category: 'documentation',
    description: 'Produce an architecture overview.',
    template: 'Produce an architecture overview of this project: components and responsibilities, data flow, external dependencies, and extension points. {{#if output}}Write it to `{{output}}`.{{else}}Return it as Markdown.{{/if}}',
  },
]

interface Row {
  id: string
  name: string
  category: string
  description: string | null
  template: string
  variables: string
  source: string | null
  builtin: number
  created_at: string
  updated_at: string
}

const toTemplate = (r: Row): PromptTemplate => ({
  id: r.id,
  name: r.name,
  category: r.category,
  description: r.description,
  template: r.template,
  variables: parseJson(r.variables, []),
  source: r.source,
  builtin: !!r.builtin,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class PromptEngine {
  constructor(private readonly db: Database) {}

  seed(): number {
    let n = 0
    const ts = now()
    for (const t of BUILTIN_TEMPLATES) {
      if (this.db.get('SELECT id FROM prompt_templates WHERE name = ?', [t.name])) continue
      this.db.insert('prompt_templates', { id: newId('tpl'), ...t, variables: JSON.stringify(extractVariables(t.template)), source: 'builtin', builtin: 1, created_at: ts, updated_at: ts })
      n++
    }
    try {
      const here = path.dirname(fileURLToPath(import.meta.url))
      const lib = JSON.parse(readFileSync(path.join(here, 'library', 'everything-chatgpt-prompts.json'), 'utf8')) as { source: string; license: string; prompts: Array<{ title: string; description: string; prompt: string }> }
      for (const p of lib.prompts) {
        const name = `library/${p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${p.description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/^-|-$/g, '')}`
        if (this.db.get('SELECT id FROM prompt_templates WHERE name = ?', [name])) continue
        this.db.insert('prompt_templates', { id: newId('tpl'), name, category: 'library', description: `${p.title} ${p.description}`.trim(), template: p.prompt, variables: '[]', source: `${lib.source} — ${lib.license}`, builtin: 1, created_at: ts, updated_at: ts })
        n++
      }
    } catch {
      // Library file missing in a stripped build: built-ins are still available.
    }
    return n
  }

  list(category?: string): PromptTemplate[] {
    return (category ? this.db.all<Row>('SELECT * FROM prompt_templates WHERE category = ? ORDER BY name', [category]) : this.db.all<Row>('SELECT * FROM prompt_templates ORDER BY category, name')).map(toTemplate)
  }

  get(idOrName: string): PromptTemplate {
    const r = this.db.get<Row>('SELECT * FROM prompt_templates WHERE id = ? OR name = ?', [idOrName, idOrName])
    if (!r) throw new NotFoundError('Prompt template')
    return toTemplate(r)
  }

  create(input: { name: string; category?: string; description?: string; template: string }): PromptTemplate {
    if (!input.name.trim() || !input.template.trim()) throw new ValidationError('Name and template are required')
    if (this.db.get('SELECT id FROM prompt_templates WHERE name = ?', [input.name])) throw new ConflictError('A template with this name exists')
    const ts = now()
    const id = newId('tpl')
    this.db.insert('prompt_templates', { id, name: input.name, category: input.category ?? 'custom', description: input.description ?? null, template: input.template, variables: JSON.stringify(extractVariables(input.template)), source: 'user', builtin: 0, created_at: ts, updated_at: ts })
    return this.get(id)
  }

  update(id: string, patch: { name?: string; category?: string; description?: string; template?: string }): PromptTemplate {
    const t = this.get(id)
    const row: Record<string, unknown> = { updated_at: now() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.category !== undefined) row.category = patch.category
    if (patch.description !== undefined) row.description = patch.description
    if (patch.template !== undefined) {
      row.template = patch.template
      row.variables = JSON.stringify(extractVariables(patch.template))
    }
    this.db.update('prompt_templates', t.id, row)
    return this.get(t.id)
  }

  delete(id: string): void {
    const t = this.get(id)
    this.db.run('DELETE FROM prompt_templates WHERE id = ?', [t.id])
  }

  render(idOrName: string, vars: Vars): { text: string; missing: string[] } {
    const t = this.get(idOrName)
    const missing = t.variables.filter((v) => lookup(vars, v) === undefined && !new RegExp(`\\{\\{\\s*${v}\\|`).test(t.template) && !new RegExp(`\\{\\{#if\\s+!?${v}`).test(t.template))
    return { text: renderTemplate(t.template, vars), missing }
  }
}
