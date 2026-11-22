/**
 * Module 13 (part): Platform MCP server.
 *
 * Exposes the platform's tool registry (file, code, git, testing, memory…)
 * as an MCP server so external MCP clients (IDEs, other agents) can use the
 * same sandboxed, audited tools. Served over stdio by `tradezone mcp`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolExecutor, ApprovalMode } from '../tools/executor.js'
import { newId } from '../db/database.js'

export interface PlatformMcpOptions {
  registry: ToolRegistry
  executor: ToolExecutor
  services: import('../platform.js').PlatformServices
  project?: { id: string; rootPath: string }
  userId?: string
  /** Tool allow-list patterns (same syntax as agents). */
  tools?: string[]
  approvalMode?: ApprovalMode
}

export function createPlatformMcpServer(opts: PlatformMcpOptions): Server {
  const server = new Server({ name: 'tradezone-platform', version: '1.0.0' }, { capabilities: { tools: {} } })
  const selected = () => opts.registry.select(opts.tools ?? ['*', '!delegate_task'], { hasProject: !!opts.project }).filter((t) => t.source !== 'mcp')
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: selected().map((t) => ({ name: t.name, description: t.description, inputSchema: opts.registry.info(t).inputSchema as { type: 'object'; properties?: Record<string, unknown> } })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tools = selected()
    const result = await opts.executor.execute(
      { type: 'tool_use', id: newId('mcpc'), name: req.params.name, input: (req.params.arguments ?? {}) as Record<string, unknown> },
      { projectRoot: opts.project?.rootPath, projectId: opts.project?.id, userId: opts.userId, agentName: 'mcp-client', signal: extra.signal, services: opts.services },
      // ask-* modes would block forever without a UI; external clients approve on their side.
      { approvalMode: opts.approvalMode === 'readonly' ? 'readonly' : 'auto', allowed: new Set(tools.map((t) => t.name)) },
    )
    return { content: [{ type: 'text', text: result.content }], isError: !!result.isError }
  })
  return server
}

export async function serveStdio(opts: PlatformMcpOptions): Promise<void> {
  const server = createPlatformMcpServer(opts)
  await server.connect(new StdioServerTransport())
}
