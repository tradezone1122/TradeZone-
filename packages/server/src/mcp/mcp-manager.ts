/**
 * Module 13: MCP Server Manager
 *
 * Persists MCP server configurations (env vars and headers encrypted at
 * rest), manages connection lifecycle, and registers each server's tools in
 * the platform tool registry as `mcp__<server>__<tool>` so agents can call
 * them through the normal execution engine (validation, approvals, audit).
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { SecretBox } from '../security/sandbox.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { EventBus } from '../events/bus.js'
import type { Logger } from '../logging/logger.js'
import { McpConnection, type McpServerConfig, type McpToolInfo } from './mcp-client.js'
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js'

export interface McpServerRecord {
  id: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command: string | null
  args: string[]
  envKeys: string[]
  url: string | null
  headerKeys: string[]
  enabled: boolean
  autoApprove: boolean
  status: 'connected' | 'disconnected' | 'error' | 'connecting'
  error: string | null
  tools: McpToolInfo[]
  serverInfo: { name?: string; version?: string }
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command: string | null
  args: string
  env_enc: string | null
  url: string | null
  headers_enc: string | null
  enabled: number
  auto_approve: number
  created_at: string
  updated_at: string
}

export interface McpServerInput {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
  enabled?: boolean
  autoApprove?: boolean
}

/** Sanitize a name into the tool-name alphabet. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64)
}

export class McpManager {
  private connections = new Map<string, McpConnection>()
  private status = new Map<string, { status: McpServerRecord['status']; error: string | null }>()

  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly registry: ToolRegistry,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  private record(r: Row): McpServerRecord {
    const conn = this.connections.get(r.id)
    const st = this.status.get(r.id) ?? { status: 'disconnected' as const, error: null }
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: parseJson(r.args, []),
      envKeys: Object.keys(this.decryptMap(r.env_enc)),
      url: r.url,
      headerKeys: Object.keys(this.decryptMap(r.headers_enc)),
      enabled: !!r.enabled,
      autoApprove: !!r.auto_approve,
      status: st.status,
      error: st.error,
      tools: conn?.tools ?? [],
      serverInfo: conn?.serverInfo ?? {},
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  private decryptMap(enc: string | null): Record<string, string> {
    if (!enc) return {}
    try {
      return JSON.parse(this.box.decrypt(enc)) as Record<string, string>
    } catch {
      return {}
    }
  }

  list(): McpServerRecord[] {
    return this.db.all<Row>('SELECT * FROM mcp_servers ORDER BY name').map((r) => this.record(r))
  }

  get(idOrName: string): McpServerRecord {
    return this.record(this.row(idOrName))
  }

  private row(idOrName: string): Row {
    const r = this.db.get<Row>('SELECT * FROM mcp_servers WHERE id = ? OR name = ?', [idOrName, idOrName])
    if (!r) throw new NotFoundError('MCP server')
    return r
  }

  create(input: McpServerInput): McpServerRecord {
    this.validate(input)
    if (this.db.get('SELECT id FROM mcp_servers WHERE name = ?', [input.name])) throw new ConflictError('An MCP server with this name exists')
    const ts = now()
    const id = newId('mcp')
    this.db.insert('mcp_servers', {
      id,
      name: input.name,
      transport: input.transport,
      command: input.command ?? null,
      args: JSON.stringify(input.args ?? []),
      env_enc: input.env && Object.keys(input.env).length ? this.box.encrypt(JSON.stringify(input.env)) : null,
      url: input.url ?? null,
      headers_enc: input.headers && Object.keys(input.headers).length ? this.box.encrypt(JSON.stringify(input.headers)) : null,
      enabled: input.enabled === false ? 0 : 1,
      auto_approve: input.autoApprove ? 1 : 0,
      created_at: ts,
      updated_at: ts,
    })
    return this.get(id)
  }

  async update(id: string, patch: Partial<McpServerInput>): Promise<McpServerRecord> {
    const current = this.row(id)
    const merged: McpServerInput = {
      name: patch.name ?? current.name,
      transport: patch.transport ?? current.transport,
      command: patch.command !== undefined ? patch.command : current.command,
      args: patch.args ?? parseJson(current.args, []),
      url: patch.url !== undefined ? patch.url : current.url,
    }
    this.validate(merged)
    const row: Record<string, unknown> = { updated_at: now(), name: merged.name, transport: merged.transport, command: merged.command ?? null, args: JSON.stringify(merged.args ?? []), url: merged.url ?? null }
    if (patch.env !== undefined) row.env_enc = Object.keys(patch.env).length ? this.box.encrypt(JSON.stringify(patch.env)) : null
    if (patch.headers !== undefined) row.headers_enc = Object.keys(patch.headers).length ? this.box.encrypt(JSON.stringify(patch.headers)) : null
    if (patch.enabled !== undefined) row.enabled = patch.enabled ? 1 : 0
    if (patch.autoApprove !== undefined) row.auto_approve = patch.autoApprove ? 1 : 0
    this.db.update('mcp_servers', current.id, row)
    if (this.connections.has(current.id)) {
      await this.disconnect(current.id)
      if (patch.enabled !== false) await this.connect(current.id).catch(() => undefined)
    }
    return this.get(current.id)
  }

  async delete(id: string): Promise<void> {
    const r = this.row(id)
    await this.disconnect(r.id)
    this.db.run('DELETE FROM mcp_servers WHERE id = ?', [r.id])
  }

  private validate(input: McpServerInput): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(input.name)) throw new ValidationError('MCP server name must be letters, digits, - or _')
    if (input.transport === 'stdio' && !input.command) throw new ValidationError('stdio servers require a command')
    if (input.transport !== 'stdio') {
      if (!input.url) throw new ValidationError('HTTP/SSE servers require a URL')
      try {
        const u = new URL(input.url)
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
      } catch {
        throw new ValidationError('Invalid MCP server URL')
      }
    }
  }

  async connect(id: string): Promise<McpServerRecord> {
    const r = this.row(id)
    await this.disconnect(r.id)
    const config: McpServerConfig = {
      name: r.name,
      transport: r.transport,
      command: r.command ?? undefined,
      args: parseJson(r.args, []),
      env: this.decryptMap(r.env_enc),
      url: r.url ?? undefined,
      headers: this.decryptMap(r.headers_enc),
    }
    const conn = new McpConnection(config)
    this.status.set(r.id, { status: 'connecting', error: null })
    try {
      await conn.connect()
      this.connections.set(r.id, conn)
      this.status.set(r.id, { status: 'connected', error: null })
      this.registerTools(r, conn)
      this.log.info('MCP server connected', { name: r.name, tools: conn.tools.length })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.status.set(r.id, { status: 'error', error: message })
      await conn.close()
      this.log.warn('MCP server connection failed', { name: r.name, error: message })
    }
    const rec = this.get(r.id)
    this.bus.publish('mcp', 'mcp.status', rec)
    return rec
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id)
    if (!conn) return
    const r = this.db.get<Row>('SELECT * FROM mcp_servers WHERE id = ?', [id])
    this.registry.unregisterWhere((t) => t.source === 'mcp' && t.category === `mcp:${r?.name ?? conn.config.name}`)
    await conn.close()
    this.connections.delete(id)
    this.status.set(id, { status: 'disconnected', error: null })
    this.bus.publish('mcp', 'mcp.status', { id, status: 'disconnected' })
  }

  private registerTools(r: Row, conn: McpConnection): void {
    this.registry.unregisterWhere((t) => t.source === 'mcp' && t.category === `mcp:${r.name}`)
    for (const tool of conn.tools) {
      this.registry.register({
        name: mcpToolName(r.name, tool.name),
        description: `[MCP ${r.name}] ${tool.description}`.slice(0, 1024),
        category: `mcp:${r.name}`,
        permission: r.auto_approve ? 'read' : 'network',
        source: 'mcp',
        jsonSchema: normalizeSchema(tool.inputSchema),
        handler: async (input, ctx) => {
          const res = await conn.callTool(tool.name, input as Record<string, unknown>, ctx.signal)
          return { content: res.text || '(empty result)', isError: res.isError, data: res.raw }
        },
      })
    }
  }

  connection(idOrName: string): McpConnection {
    const r = this.row(idOrName)
    const c = this.connections.get(r.id)
    if (!c) throw new ValidationError(`MCP server '${r.name}' is not connected`)
    return c
  }

  async connectEnabled(): Promise<void> {
    const rows = this.db.all<Row>('SELECT * FROM mcp_servers WHERE enabled = 1')
    await Promise.all(rows.map((r) => this.connect(r.id).catch(() => undefined)))
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}

function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const s = { ...schema }
  if (s.type !== 'object') s.type = 'object'
  if (!s.properties) s.properties = {}
  delete s.$schema
  return s
}
