/**
 * Agent definitions: CRUD over the `agents` table plus seeding of the
 * built-in roles.
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js'
import { BUILTIN_ROLES } from '../prompts/roles.js'
import type { ApprovalMode } from '../tools/executor.js'
import type { Effort } from '../core/types.js'

export interface AgentDefinition {
  id: string
  name: string
  role: string
  description: string | null
  systemPrompt: string
  model: string | null
  tools: string[]
  capabilities: string[]
  maxTurns: number
  temperature: number | null
  effort: Effort | null
  approvalMode: ApprovalMode
  skills: string[]
  builtin: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  name: string
  role: string
  description: string | null
  system_prompt: string
  model: string | null
  tools: string
  capabilities: string
  max_turns: number
  temperature: number | null
  effort: Effort | null
  approval_mode: ApprovalMode
  skills: string
  builtin: number
  enabled: number
  created_at: string
  updated_at: string
}

const toAgent = (r: Row): AgentDefinition => ({
  id: r.id,
  name: r.name,
  role: r.role,
  description: r.description,
  systemPrompt: r.system_prompt,
  model: r.model,
  tools: parseJson(r.tools, ['*']),
  capabilities: parseJson(r.capabilities, []),
  maxTurns: r.max_turns,
  temperature: r.temperature,
  effort: r.effort,
  approvalMode: r.approval_mode,
  skills: parseJson(r.skills, []),
  builtin: !!r.builtin,
  enabled: !!r.enabled,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export type AgentInput = {
  name: string
  role?: string
  description?: string | null
  systemPrompt: string
  model?: string | null
  tools?: string[]
  capabilities?: string[]
  maxTurns?: number
  temperature?: number | null
  effort?: Effort | null
  approvalMode?: ApprovalMode
  skills?: string[]
  enabled?: boolean
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/

export class AgentService {
  constructor(private readonly db: Database) {}

  seed(): number {
    let n = 0
    for (const r of BUILTIN_ROLES) {
      if (this.db.get('SELECT id FROM agents WHERE name = ?', [r.name])) continue
      this.create({ name: r.name, role: r.role, description: r.description, systemPrompt: r.systemPrompt, tools: r.tools, capabilities: r.capabilities, approvalMode: r.approvalMode, maxTurns: r.maxTurns, effort: r.effort ?? null }, true)
      n++
    }
    return n
  }

  list(includeDisabled = true): AgentDefinition[] {
    return this.db.all<Row>(`SELECT * FROM agents ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY builtin DESC, name`).map(toAgent)
  }

  get(idOrName: string): AgentDefinition {
    const r = this.db.get<Row>('SELECT * FROM agents WHERE id = ? OR name = ?', [idOrName, idOrName])
    if (!r) throw new NotFoundError(`Agent '${idOrName}'`)
    return toAgent(r)
  }

  create(input: AgentInput, builtin = false): AgentDefinition {
    if (!NAME_RE.test(input.name)) throw new ValidationError('Agent name must be 2-41 chars: lowercase letters, digits, - or _')
    if (!input.systemPrompt?.trim()) throw new ValidationError('System prompt is required')
    if (this.db.get('SELECT id FROM agents WHERE name = ?', [input.name])) throw new ConflictError(`Agent '${input.name}' already exists`)
    const ts = now()
    const id = newId('agt')
    this.db.insert('agents', {
      id,
      name: input.name,
      role: input.role ?? 'custom',
      description: input.description ?? null,
      system_prompt: input.systemPrompt,
      model: input.model ?? null,
      tools: JSON.stringify(input.tools ?? ['*']),
      capabilities: JSON.stringify(input.capabilities ?? []),
      max_turns: clampInt(input.maxTurns ?? 25, 1, 200),
      temperature: input.temperature ?? null,
      effort: input.effort ?? null,
      approval_mode: input.approvalMode ?? 'ask-writes',
      skills: JSON.stringify(input.skills ?? []),
      builtin: builtin ? 1 : 0,
      enabled: input.enabled === false ? 0 : 1,
      created_at: ts,
      updated_at: ts,
    })
    return this.get(id)
  }

  update(id: string, patch: Partial<AgentInput>): AgentDefinition {
    const a = this.get(id)
    if (patch.name !== undefined && patch.name !== a.name) {
      if (!NAME_RE.test(patch.name)) throw new ValidationError('Invalid agent name')
      if (this.db.get('SELECT id FROM agents WHERE name = ?', [patch.name])) throw new ConflictError(`Agent '${patch.name}' already exists`)
    }
    const map: Record<string, unknown> = { updated_at: now() }
    if (patch.name !== undefined) map.name = patch.name
    if (patch.role !== undefined) map.role = patch.role
    if (patch.description !== undefined) map.description = patch.description
    if (patch.systemPrompt !== undefined) map.system_prompt = patch.systemPrompt
    if (patch.model !== undefined) map.model = patch.model
    if (patch.tools !== undefined) map.tools = JSON.stringify(patch.tools)
    if (patch.capabilities !== undefined) map.capabilities = JSON.stringify(patch.capabilities)
    if (patch.maxTurns !== undefined) map.max_turns = clampInt(patch.maxTurns, 1, 200)
    if (patch.temperature !== undefined) map.temperature = patch.temperature
    if (patch.effort !== undefined) map.effort = patch.effort
    if (patch.approvalMode !== undefined) map.approval_mode = patch.approvalMode
    if (patch.skills !== undefined) map.skills = JSON.stringify(patch.skills)
    if (patch.enabled !== undefined) map.enabled = patch.enabled ? 1 : 0
    this.db.update('agents', a.id, map)
    return this.get(a.id)
  }

  delete(id: string): void {
    const a = this.get(id)
    if (a.builtin) throw new ValidationError('Built-in agents cannot be deleted (disable them instead)')
    this.db.run('DELETE FROM agents WHERE id = ?', [a.id])
  }

  clone(id: string, newName: string): AgentDefinition {
    const a = this.get(id)
    return this.create({ ...a, name: newName, description: `Copy of ${a.name}: ${a.description ?? ''}` })
  }
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)))
}
