/**
 * Module 10: Tool Registry
 *
 * Central catalogue of every tool an agent can call: built-in tools, tools
 * contributed by plugins, and tools discovered on connected MCP servers.
 * Tools declare a zod schema (converted to JSON Schema for the model) or a
 * raw JSON Schema (MCP), a permission class and a handler.
 */
import { z } from 'zod'
import type { ToolSpec } from '../core/types.js'
import { ValidationError } from '../core/errors.js'

export type ToolPermission = 'read' | 'write' | 'execute' | 'network'

export interface ToolContext {
  /** Absolute path of the project root the tool operates in (if any). */
  projectRoot?: string
  projectId?: string
  userId?: string
  runId?: string
  agentName?: string
  teamRunId?: string
  /** Delegation depth of the calling run (0 = top level). */
  depth?: number
  signal: AbortSignal
  /** Platform services (typed loosely to avoid an import cycle). */
  services: import('../platform.js').PlatformServices
  /** Emit a progress event to the run stream. */
  emit?: (type: string, data: unknown) => void
}

export interface ToolResult {
  content: string
  isError?: boolean
  /** Structured data for UIs (not sent to the model). */
  data?: unknown
}

export interface ToolDefinition<I = Record<string, unknown>> {
  name: string
  description: string
  category: string
  permission: ToolPermission
  source: 'builtin' | 'plugin' | 'mcp'
  /** zod schema for validation (built-in / plugin tools). */
  schema?: z.ZodType<I>
  /** Raw JSON Schema (MCP tools). */
  jsonSchema?: Record<string, unknown>
  /** Tools that need a project context fail fast without one. */
  requiresProject?: boolean
  handler: (input: I, ctx: ToolContext) => Promise<ToolResult>
}

export interface ToolInfo {
  name: string
  description: string
  category: string
  permission: ToolPermission
  source: ToolDefinition['source']
  requiresProject: boolean
  inputSchema: Record<string, unknown>
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any>>()
  private listeners = new Set<() => void>()

  register<I>(tool: ToolDefinition<I>): void {
    if (!NAME_RE.test(tool.name)) throw new ValidationError(`Invalid tool name '${tool.name}'`)
    if (!tool.schema && !tool.jsonSchema) throw new ValidationError(`Tool '${tool.name}' needs a schema`)
    this.tools.set(tool.name, tool as ToolDefinition<any>)
    this.changed()
  }

  unregister(name: string): boolean {
    const ok = this.tools.delete(name)
    if (ok) this.changed()
    return ok
  }

  unregisterWhere(pred: (t: ToolDefinition<any>) => boolean): number {
    let n = 0
    for (const [name, t] of this.tools) if (pred(t)) {
      this.tools.delete(name)
      n++
    }
    if (n) this.changed()
    return n
  }

  get(name: string): ToolDefinition<any> | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): ToolInfo[] {
    return [...this.tools.values()].map((t) => this.info(t)).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  }

  info(t: ToolDefinition<any>): ToolInfo {
    return {
      name: t.name,
      description: t.description,
      category: t.category,
      permission: t.permission,
      source: t.source,
      requiresProject: !!t.requiresProject,
      inputSchema: inputSchemaOf(t),
    }
  }

  /**
   * Select tools by allow-list patterns: "*" (all), exact names, a category
   * ("category:git"), or a prefix glob ("mcp__github__*").
   */
  select(patterns: string[], opts: { hasProject: boolean }): ToolDefinition<any>[] {
    const all = [...this.tools.values()]
    const picked = new Map<string, ToolDefinition<any>>()
    for (const p of patterns) {
      for (const t of all) {
        const match =
          p === '*' ||
          p === t.name ||
          (p.startsWith('category:') && t.category === p.slice(9)) ||
          (p.endsWith('*') && t.name.startsWith(p.slice(0, -1)))
        if (match) picked.set(t.name, t)
      }
    }
    for (const p of patterns) if (p.startsWith('!')) picked.delete(p.slice(1))
    return [...picked.values()].filter((t) => opts.hasProject || !t.requiresProject)
  }

  specs(tools: ToolDefinition<any>[]): ToolSpec[] {
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchemaOf(t) }))
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const l of this.listeners) l()
  }
}

const schemaCache = new WeakMap<object, Record<string, unknown>>()

export function inputSchemaOf(t: ToolDefinition<any>): Record<string, unknown> {
  if (t.jsonSchema) return t.jsonSchema
  const cached = schemaCache.get(t)
  if (cached) return cached
  const json = z.toJSONSchema(t.schema!, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  delete json.$schema
  if (json.type !== 'object') throw new ValidationError(`Tool '${t.name}' schema must be an object`)
  schemaCache.set(t, json)
  return json
}

/** Minimal JSON-Schema validation for MCP tools (required + primitive types). */
export function validateAgainstJsonSchema(schema: Record<string, unknown>, input: Record<string, unknown>): string[] {
  const errors: string[] = []
  const required = (schema.required as string[] | undefined) ?? []
  for (const k of required) if (input[k] === undefined) errors.push(`Missing required property '${k}'`)
  const props = (schema.properties as Record<string, { type?: string | string[] }> | undefined) ?? {}
  for (const [k, v] of Object.entries(input)) {
    const spec = props[k]
    if (!spec?.type) continue
    const types = Array.isArray(spec.type) ? spec.type : [spec.type]
    const actual = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'))
    if (!ok) errors.push(`Property '${k}' should be ${types.join('|')} but is ${actual}`)
  }
  return errors
}
