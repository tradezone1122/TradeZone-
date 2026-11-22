/**
 * Module 12: MCP Client
 *
 * Connects to Model Context Protocol servers over stdio, Streamable HTTP or
 * SSE using the official @modelcontextprotocol/sdk, and exposes their tools,
 * resources and prompts.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { childEnv } from '../terminal/process.js'

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  text: string
  isError: boolean
  raw: unknown
}

export class McpConnection {
  private client: Client | null = null
  private transport: Transport | null = null
  tools: McpToolInfo[] = []
  serverInfo: { name?: string; version?: string } = {}
  stderr = ''

  constructor(readonly config: McpServerConfig) {}

  get connected(): boolean {
    return this.client !== null
  }

  async connect(timeoutMs = 30_000): Promise<void> {
    const c = this.config
    let transport: Transport
    if (c.transport === 'stdio') {
      if (!c.command) throw new Error('stdio MCP server requires a command')
      const t = new StdioClientTransport({ command: c.command, args: c.args ?? [], env: { ...childEnv(), ...(c.env ?? {}) }, cwd: c.cwd, stderr: 'pipe' })
      t.stderr?.on('data', (d: Buffer) => {
        this.stderr = (this.stderr + d.toString('utf8')).slice(-20_000)
      })
      transport = t
    } else {
      if (!c.url) throw new Error(`${c.transport} MCP server requires a URL`)
      const url = new URL(c.url)
      const requestInit = { headers: c.headers ?? {} }
      transport = c.transport === 'http' ? new StreamableHTTPClientTransport(url, { requestInit }) : new SSEClientTransport(url, { requestInit })
    }
    const client = new Client({ name: 'tradezone-ai-platform', version: '1.0.0' }, { capabilities: {} })
    const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`MCP connect timed out after ${timeoutMs} ms${this.stderr ? `: ${this.stderr.slice(-500)}` : ''}`)), timeoutMs))
    await Promise.race([client.connect(transport), timer])
    this.client = client
    this.transport = transport
    const v = client.getServerVersion()
    this.serverInfo = { name: v?.name, version: v?.version }
    await this.refreshTools()
  }

  async refreshTools(): Promise<McpToolInfo[]> {
    const client = this.require()
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const res = await client.listTools(cursor ? { cursor } : undefined)
      for (const t of res.tools) tools.push({ name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} } })
      cursor = res.nextCursor
    } while (cursor)
    this.tools = tools
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const client = this.require()
    const res = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 5 * 60_000 })
    const content = (res.content as Array<{ type: string; text?: string; resource?: { text?: string; uri?: string }; mimeType?: string }> | undefined) ?? []
    const text = content
      .map((c) => {
        if (c.type === 'text') return c.text ?? ''
        if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`
        if (c.type === 'image') return `[image ${c.mimeType ?? ''}]`
        return `[${c.type}]`
      })
      .join('\n')
    const structured = (res as { structuredContent?: unknown }).structuredContent
    return { text: text || (structured ? JSON.stringify(structured, null, 2) : ''), isError: !!res.isError, raw: res }
  }

  async listResources() {
    const client = this.require()
    try {
      return (await client.listResources()).resources
    } catch {
      return []
    }
  }

  async readResource(uri: string) {
    return this.require().readResource({ uri })
  }

  async listPrompts() {
    const client = this.require()
    try {
      return (await client.listPrompts()).prompts
    } catch {
      return []
    }
  }

  async getPrompt(name: string, args: Record<string, string> = {}) {
    return this.require().getPrompt({ name, arguments: args })
  }

  async close(): Promise<void> {
    try {
      await this.client?.close()
    } catch {
      /* ignore */
    }
    this.client = null
    this.transport = null
  }

  private require(): Client {
    if (!this.client) throw new Error(`MCP server '${this.config.name}' is not connected`)
    return this.client
  }
}
