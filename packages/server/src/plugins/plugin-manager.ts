/**
 * Module 15: Plugin System
 *
 * A plugin is a directory with a `plugin.json` manifest and an ES module
 * entry exporting `activate(api)` (and optionally `deactivate()`). Through the
 * API a plugin can contribute tools, prompt templates, skills and agents and
 * subscribe to platform events. Permissions declared in the manifest gate
 * which tool permission classes the plugin may register.
 *
 * Manifest:
 * {
 *   "name": "my-plugin", "version": "1.0.0", "description": "...",
 *   "main": "index.js",
 *   "permissions": ["tools:read", "tools:write", "tools:execute", "tools:network", "events", "prompts", "skills", "agents"]
 * }
 */
import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { ToolRegistry, ToolPermission, ToolResult, ToolContext } from '../tools/registry.js'
import type { EventBus, BusEvent } from '../events/bus.js'
import type { PromptEngine } from '../prompts/prompt-engine.js'
import type { SkillsEngine } from '../skills/skills-engine.js'
import type { AgentService, AgentInput } from '../agents/agent-service.js'
import type { Logger } from '../logging/logger.js'
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js'

const ManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  version: z.string().min(1),
  description: z.string().optional(),
  main: z.string().default('index.js'),
  permissions: z.array(z.string()).default([]),
})

export type PluginManifest = z.infer<typeof ManifestSchema>

export interface PluginRecord {
  id: string
  name: string
  version: string
  description: string | null
  path: string
  permissions: string[]
  enabled: boolean
  status: 'installed' | 'active' | 'error' | 'disabled'
  error: string | null
  contributions: { tools: string[]; prompts: string[]; skills: string[]; agents: string[] }
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  name: string
  version: string
  description: string | null
  path: string
  permissions: string
  enabled: number
  status: PluginRecord['status']
  error: string | null
  created_at: string
  updated_at: string
}

export interface PluginToolSpec {
  name: string
  description: string
  permission: ToolPermission
  inputSchema: Record<string, unknown>
  requiresProject?: boolean
  handler: (input: Record<string, unknown>, ctx: { projectRoot?: string; projectId?: string; userId?: string; signal: AbortSignal }) => Promise<ToolResult | string>
}

export interface PluginApi {
  readonly name: string
  readonly version: string
  registerTool(spec: PluginToolSpec): void
  registerPrompt(input: { name: string; template: string; description?: string; category?: string }): void
  registerSkill(markdown: string): void
  registerAgent(input: AgentInput): void
  on(topic: string, handler: (event: BusEvent) => void): void
  log: { info(msg: string, ctx?: Record<string, unknown>): void; warn(msg: string, ctx?: Record<string, unknown>): void; error(msg: string, ctx?: Record<string, unknown>): void }
}

interface Active {
  module: { activate?: (api: PluginApi) => unknown; deactivate?: () => unknown }
  disposers: Array<() => void>
  contributions: PluginRecord['contributions']
}

export class PluginManager {
  private active = new Map<string, Active>()

  constructor(
    private readonly db: Database,
    private readonly pluginsDir: string,
    private readonly registry: ToolRegistry,
    private readonly bus: EventBus,
    private readonly prompts: PromptEngine,
    private readonly skills: SkillsEngine,
    private readonly agents: AgentService,
    private readonly log: Logger,
  ) {}

  private toRecord(r: Row): PluginRecord {
    return {
      id: r.id,
      name: r.name,
      version: r.version,
      description: r.description,
      path: r.path,
      permissions: parseJson(r.permissions, []),
      enabled: !!r.enabled,
      status: r.status,
      error: r.error,
      contributions: this.active.get(r.id)?.contributions ?? { tools: [], prompts: [], skills: [], agents: [] },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  list(): PluginRecord[] {
    return this.db.all<Row>('SELECT * FROM plugins ORDER BY name').map((r) => this.toRecord(r))
  }

  get(idOrName: string): PluginRecord {
    return this.toRecord(this.row(idOrName))
  }

  private row(idOrName: string): Row {
    const r = this.db.get<Row>('SELECT * FROM plugins WHERE id = ? OR name = ?', [idOrName, idOrName])
    if (!r) throw new NotFoundError('Plugin')
    return r
  }

  async readManifest(dir: string): Promise<PluginManifest> {
    const file = path.join(dir, 'plugin.json')
    if (!existsSync(file)) throw new ValidationError(`No plugin.json in ${dir}`)
    const parsed = ManifestSchema.safeParse(JSON.parse(await fsp.readFile(file, 'utf8')))
    if (!parsed.success) throw new ValidationError(`Invalid plugin.json: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const main = path.resolve(dir, parsed.data.main)
    if (!main.startsWith(path.resolve(dir) + path.sep)) throw new ValidationError('Plugin entry must be inside the plugin directory')
    if (!existsSync(main)) throw new ValidationError(`Plugin entry not found: ${parsed.data.main}`)
    return parsed.data
  }

  /** Install a plugin from a directory (copied into the managed plugins directory). */
  async install(sourceDir: string, opts: { enable?: boolean } = {}): Promise<PluginRecord> {
    const manifest = await this.readManifest(sourceDir)
    if (this.db.get('SELECT id FROM plugins WHERE name = ?', [manifest.name])) throw new ConflictError(`Plugin '${manifest.name}' is already installed`)
    const dest = path.join(this.pluginsDir, manifest.name)
    if (path.resolve(sourceDir) !== path.resolve(dest)) {
      await fsp.rm(dest, { recursive: true, force: true })
      await fsp.mkdir(this.pluginsDir, { recursive: true })
      await fsp.cp(sourceDir, dest, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}.cache`) })
    }
    const ts = now()
    const id = newId('plg')
    this.db.insert('plugins', { id, name: manifest.name, version: manifest.version, description: manifest.description ?? null, path: dest, permissions: JSON.stringify(manifest.permissions), enabled: opts.enable === false ? 0 : 1, status: 'installed', error: null, created_at: ts, updated_at: ts })
    if (opts.enable !== false) await this.activate(id)
    return this.get(id)
  }

  async activate(id: string): Promise<PluginRecord> {
    const r = this.row(id)
    if (this.active.has(r.id)) return this.get(r.id)
    const permissions = new Set(parseJson<string[]>(r.permissions, []))
    const contributions: PluginRecord['contributions'] = { tools: [], prompts: [], skills: [], agents: [] }
    const disposers: Array<() => void> = []
    const log = this.log.child(`plugin:${r.name}`)
    const need = (perm: string) => {
      if (!permissions.has(perm)) throw new ValidationError(`Plugin '${r.name}' lacks permission '${perm}'`)
    }
    const api: PluginApi = {
      name: r.name,
      version: r.version,
      registerTool: (spec) => {
        need(`tools:${spec.permission}`)
        const name = `plugin_${r.name.replace(/-/g, '_')}__${spec.name}`.slice(0, 64)
        this.registry.register({
          name,
          description: `[plugin ${r.name}] ${spec.description}`,
          category: `plugin:${r.name}`,
          permission: spec.permission,
          source: 'plugin',
          jsonSchema: { type: 'object', properties: {}, ...spec.inputSchema },
          requiresProject: spec.requiresProject,
          handler: async (input: Record<string, unknown>, ctx: ToolContext) => {
            const out = await spec.handler(input, { projectRoot: ctx.projectRoot, projectId: ctx.projectId, userId: ctx.userId, signal: ctx.signal })
            return typeof out === 'string' ? { content: out } : out
          },
        })
        contributions.tools.push(name)
        disposers.push(() => this.registry.unregister(name))
      },
      registerPrompt: (input) => {
        need('prompts')
        const name = `${r.name}/${input.name}`
        try {
          this.prompts.create({ ...input, name, category: input.category ?? `plugin:${r.name}` })
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e
        }
        contributions.prompts.push(name)
      },
      registerSkill: (markdown) => {
        need('skills')
        const s = this.skills.install(markdown, `plugin:${r.name}`, true)
        contributions.skills.push(s.name)
      },
      registerAgent: (input) => {
        need('agents')
        try {
          this.agents.create(input)
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e
        }
        contributions.agents.push(input.name)
      },
      on: (topic, handler) => {
        need('events')
        disposers.push(this.bus.subscribe(topic, handler))
      },
      log: { info: (m, c) => log.info(m, c), warn: (m, c) => log.warn(m, c), error: (m, c) => log.error(m, c) },
    }
    try {
      const manifest = await this.readManifest(r.path)
      const url = pathToFileURL(path.join(r.path, manifest.main)).href + `?v=${Date.now()}`
      const module = (await import(url)) as Active['module']
      if (typeof module.activate !== 'function') throw new ValidationError('Plugin entry does not export activate(api)')
      await module.activate(api)
      this.active.set(r.id, { module, disposers, contributions })
      this.db.update('plugins', r.id, { status: 'active', error: null, enabled: 1, updated_at: now() })
      log.info('Plugin activated', { contributions })
    } catch (err) {
      for (const d of disposers) d()
      const message = err instanceof Error ? err.message : String(err)
      this.db.update('plugins', r.id, { status: 'error', error: message, updated_at: now() })
      log.error('Plugin activation failed', { error: message })
    }
    this.bus.publish('plugins', 'plugin.status', this.get(r.id))
    return this.get(r.id)
  }

  async deactivate(id: string, disable = true): Promise<PluginRecord> {
    const r = this.row(id)
    const a = this.active.get(r.id)
    if (a) {
      try {
        await a.module.deactivate?.()
      } catch (err) {
        this.log.warn('Plugin deactivate() threw', { plugin: r.name, error: err })
      }
      for (const d of a.disposers) d()
      this.active.delete(r.id)
    }
    this.db.update('plugins', r.id, { status: disable ? 'disabled' : 'installed', enabled: disable ? 0 : r.enabled, updated_at: now() })
    return this.get(r.id)
  }

  async uninstall(id: string): Promise<void> {
    const r = this.row(id)
    await this.deactivate(r.id)
    this.db.run('DELETE FROM plugins WHERE id = ?', [r.id])
    if (path.resolve(r.path).startsWith(path.resolve(this.pluginsDir) + path.sep)) await fsp.rm(r.path, { recursive: true, force: true })
  }

  async activateEnabled(): Promise<void> {
    for (const r of this.db.all<Row>('SELECT * FROM plugins WHERE enabled = 1')) await this.activate(r.id)
  }

  /** Discover plugin folders dropped into the plugins directory and register them. */
  async discover(): Promise<string[]> {
    if (!existsSync(this.pluginsDir)) return []
    const found: string[] = []
    for (const e of await fsp.readdir(this.pluginsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const dir = path.join(this.pluginsDir, e.name)
      if (!existsSync(path.join(dir, 'plugin.json'))) continue
      try {
        const m = await this.readManifest(dir)
        if (!this.db.get('SELECT id FROM plugins WHERE name = ?', [m.name])) {
          await this.install(dir, { enable: false })
          found.push(m.name)
        }
      } catch (err) {
        this.log.warn('Skipping invalid plugin directory', { dir, error: err })
      }
    }
    return found
  }
}
