import os from 'node:os'
import { z } from 'zod'
import type { Api } from '../http.js'
import { IdParams } from '../http.js'
import { PROVIDER_PRESETS } from '../../providers/manager.js'
import { newId } from '../../db/database.js'
import { textOf } from '../../core/types.js'
import { logHub } from '../../logging/logger.js'
import { projectRef } from './agents.js'

const ProviderKind = z.enum(['anthropic', 'openai-compatible'])
const McpBody = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().nullish(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().nullish(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
})
const TaskBody = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).optional(),
  projectId: z.string().nullish(),
  priority: z.number().int().min(-10).max(10).optional(),
  assignee: z.string().nullish(),
  dependsOn: z.array(z.string()).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  schedule: z.string().nullish(),
  autoRun: z.boolean().optional(),
})

export function platformRoutes(api: Api): void {
  const s = api.services

  // --------------------------------------------------------------- tools
  api.get('/api/tools', { perm: 'tools:read' }, () => s.registry.list())
  api.post('/api/tools/:id/execute', { perm: 'tools:execute', audit: 'tool.execute', params: IdParams, body: z.object({ input: z.record(z.string(), z.unknown()).default({}), projectId: z.string().nullish() }) }, async ({ params, body, principal }) => {
    const project = projectRef(s, principal, body.projectId)
    const tool = s.registry.get(params.id)
    const result = await s.executor.execute(
      { type: 'tool_use', id: newId('manual'), name: params.id, input: body.input },
      { projectRoot: project?.rootPath, projectId: project?.id, userId: principal.user.id, agentName: `user:${principal.user.username}`, signal: AbortSignal.timeout(10 * 60_000), services: s },
      { approvalMode: principal.user.role === 'viewer' ? 'readonly' : 'auto', allowed: new Set(tool ? [tool.name] : []) },
    )
    return result
  })
  api.get('/api/tool-calls', { perm: 'tools:read', query: z.object({ tool: z.string().optional(), limit: z.coerce.number().int().max(500).optional() }) }, ({ query }) =>
    s.db.all(`SELECT id, run_id, tool, is_error, duration_ms, created_at, substr(input, 1, 500) AS input, substr(output, 1, 500) AS output FROM tool_calls ${query.tool ? 'WHERE tool = ?' : ''} ORDER BY created_at DESC LIMIT ?`, query.tool ? [query.tool, query.limit ?? 100] : [query.limit ?? 100]),
  )

  // ------------------------------------------------------------ providers
  api.get('/api/providers', { perm: 'providers:read' }, () => s.providers.list())
  api.get('/api/providers/presets', { perm: 'providers:read' }, () => PROVIDER_PRESETS)
  api.post('/api/providers', { perm: 'providers:manage', audit: 'provider.create', body: z.object({ id: z.string().optional(), name: z.string().min(1), kind: ProviderKind, baseUrl: z.string().url().nullish(), apiKey: z.string().nullish(), models: z.array(z.string()).optional(), defaultModel: z.string().nullish(), options: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional() }) }, ({ body }) => s.providers.create(body))
  api.patch('/api/providers/:id', { perm: 'providers:manage', audit: 'provider.update', params: IdParams, body: z.object({ name: z.string().optional(), baseUrl: z.string().url().nullish(), apiKey: z.string().nullish(), models: z.array(z.string()).optional(), defaultModel: z.string().nullish(), options: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional() }) }, ({ params, body }) => s.providers.update(params.id, body))
  api.delete('/api/providers/:id', { perm: 'providers:manage', audit: 'provider.delete', params: IdParams }, ({ params }) => s.providers.delete(params.id))
  api.post('/api/providers/:id/test', { perm: 'providers:read', params: IdParams }, ({ params }) => s.providers.test(params.id))
  api.get('/api/providers/:id/models', { perm: 'providers:read', params: IdParams }, async ({ params }) => s.providers.client(params.id).listModels(AbortSignal.timeout(15_000)))

  // ------------------------------------------------------------ AI router
  api.get('/api/ai/routes', { perm: 'providers:read' }, () => s.router.listRoutes())
  api.put('/api/ai/routes/:id', { perm: 'providers:manage', audit: 'route.upsert', params: IdParams, body: z.object({ description: z.string().nullish(), targets: z.array(z.object({ provider: z.string(), model: z.string() })).min(1) }) }, ({ params, body }) => s.router.upsertRoute(params.id, body.targets, body.description))
  api.delete('/api/ai/routes/:id', { perm: 'providers:manage', audit: 'route.delete', params: IdParams }, ({ params }) => s.router.deleteRoute(params.id))
  api.get('/api/ai/resolve', { perm: 'providers:read', query: z.object({ model: z.string().optional() }) }, ({ query }) => s.router.resolve(query.model))
  api.post('/api/ai/chat', { perm: 'agents:run', body: z.object({ model: z.string().optional(), system: z.string().max(100_000).optional(), messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1), maxTokens: z.number().int().min(1).max(128_000).optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() }) }, async ({ body, principal }) => {
    const res = await s.router.chat(body.model, { system: body.system, messages: body.messages.map((m) => ({ role: m.role, content: [{ type: 'text' as const, text: m.content }] })), maxTokens: body.maxTokens ?? 8000, effort: body.effort }, { userId: principal.user.id })
    return { text: textOf(res.content), model: res.model, provider: res.target.provider, stopReason: res.stopReason, usage: res.usage }
  })
  api.get('/api/ai/usage', { perm: 'monitoring:read', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(7) }) }, ({ query }) => {
    const since = new Date(Date.now() - query.days * 86_400_000).toISOString()
    return {
      byModel: s.db.all('SELECT provider_id, model, COUNT(*) AS requests, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, AVG(latency_ms) AS avg_latency_ms, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors FROM llm_usage WHERE created_at >= ? GROUP BY provider_id, model ORDER BY requests DESC', [since]),
      byDay: s.db.all('SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS requests, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out FROM llm_usage WHERE created_at >= ? GROUP BY day ORDER BY day', [since]),
    }
  })

  // -------------------------------------------------------------- prompts
  api.get('/api/prompts', { perm: 'prompts:read', query: z.object({ category: z.string().optional() }) }, ({ query }) => s.prompts.list(query.category))
  api.get('/api/prompts/:id', { perm: 'prompts:read', params: IdParams }, ({ params }) => s.prompts.get(params.id))
  api.post('/api/prompts', { perm: 'prompts:write', body: z.object({ name: z.string().min(1).max(120), category: z.string().max(60).optional(), description: z.string().max(1000).optional(), template: z.string().min(1).max(100_000) }) }, ({ body }) => s.prompts.create(body))
  api.patch('/api/prompts/:id', { perm: 'prompts:write', params: IdParams, body: z.object({ name: z.string().optional(), category: z.string().optional(), description: z.string().optional(), template: z.string().optional() }) }, ({ params, body }) => s.prompts.update(params.id, body))
  api.delete('/api/prompts/:id', { perm: 'prompts:write', params: IdParams }, ({ params }) => s.prompts.delete(params.id))
  api.post('/api/prompts/:id/render', { perm: 'prompts:read', params: IdParams, body: z.object({ variables: z.record(z.string(), z.unknown()).default({}) }) }, ({ params, body }) => s.prompts.render(params.id, body.variables))

  // --------------------------------------------------------------- memory
  const Scope = z.enum(['global', 'user', 'project', 'agent'])
  api.get('/api/memory', { perm: 'memory:read', query: z.object({ scope: Scope.optional(), scopeId: z.string().optional(), kind: z.string().optional(), limit: z.coerce.number().int().max(500).optional(), offset: z.coerce.number().int().optional() }) }, ({ query }) => s.memory.list(query))
  api.get('/api/memory/stats', { perm: 'memory:read' }, () => s.memory.stats())
  api.get('/api/memory/search', { perm: 'memory:read', query: z.object({ q: z.string().min(1), scope: Scope.optional(), scopeId: z.string().optional(), limit: z.coerce.number().int().max(50).optional() }) }, ({ query, principal }) => {
    const scopes = query.scope ? [{ scope: query.scope, scopeId: query.scopeId ?? null }] : [{ scope: 'global' as const }, { scope: 'user' as const, scopeId: principal.user.id }, ...(query.scopeId ? [{ scope: 'project' as const, scopeId: query.scopeId }, { scope: 'agent' as const, scopeId: query.scopeId }] : [])]
    return s.memory.search(query.q, scopes, query.limit ?? 20)
  })
  api.post('/api/memory', { perm: 'memory:write', body: z.object({ scope: Scope, scopeId: z.string().nullish(), content: z.string().min(1), kind: z.string().optional(), tags: z.array(z.string()).optional(), importance: z.number().min(0).max(1).optional() }) }, ({ body, principal }) => s.memory.add({ ...body, createdBy: principal.user.username, source: 'ui' }))
  api.patch('/api/memory/:id', { perm: 'memory:write', params: IdParams, body: z.object({ content: z.string().optional(), tags: z.array(z.string()).optional(), importance: z.number().min(0).max(1).optional(), kind: z.string().optional() }) }, ({ params, body }) => s.memory.update(params.id, body))
  api.delete('/api/memory/:id', { perm: 'memory:write', params: IdParams }, ({ params }) => s.memory.delete(params.id))
  api.post('/api/memory/prune', { perm: 'memory:write', audit: 'memory.prune' }, () => ({ removed: s.memory.prune(s.settings.get<number>('memory.maxPerScope')) }))

  // --------------------------------------------------------------- skills
  api.get('/api/skills', { perm: 'skills:read' }, () => s.skills.list())
  api.get('/api/skills/:id', { perm: 'skills:read', params: IdParams }, ({ params }) => {
    const sk = s.skills.get(params.id)
    return { ...sk, markdown: s.skills.toMarkdown(sk) }
  })
  api.post('/api/skills', { perm: 'skills:manage', audit: 'skill.install', body: z.object({ markdown: z.string().min(10).max(200_000), overwrite: z.boolean().optional() }) }, ({ body }) => s.skills.install(body.markdown, 'user', body.overwrite))
  api.post('/api/skills/import-directory', { perm: 'skills:manage', audit: 'skill.import', body: z.object({ path: z.string().min(1) }) }, ({ body }) => s.skills.installFromDirectory(body.path))
  api.put('/api/skills/:id', { perm: 'skills:manage', audit: 'skill.update', params: IdParams, body: z.object({ markdown: z.string().min(10) }) }, ({ params, body }) => s.skills.update(params.id, body.markdown))
  api.post('/api/skills/:id/enabled', { perm: 'skills:manage', params: IdParams, body: z.object({ enabled: z.boolean() }) }, ({ params, body }) => s.skills.setEnabled(params.id, body.enabled))
  api.delete('/api/skills/:id', { perm: 'skills:manage', audit: 'skill.delete', params: IdParams }, ({ params }) => s.skills.delete(params.id))
  api.post('/api/skills/match', { perm: 'skills:read', body: z.object({ text: z.string().min(1) }) }, ({ body }) => s.skills.match(body.text, 5).map((m) => ({ name: m.skill.name, description: m.skill.description, score: m.score })))

  // -------------------------------------------------------------- plugins
  api.get('/api/plugins', { perm: 'plugins:read' }, () => s.plugins.list())
  api.post('/api/plugins/install', { perm: 'plugins:manage', audit: 'plugin.install', body: z.object({ path: z.string().min(1), enable: z.boolean().optional() }) }, ({ body }) => s.plugins.install(body.path, { enable: body.enable }))
  api.post('/api/plugins/discover', { perm: 'plugins:manage' }, async () => ({ discovered: await s.plugins.discover() }))
  api.post('/api/plugins/:id/enable', { perm: 'plugins:manage', audit: 'plugin.enable', params: IdParams }, ({ params }) => s.plugins.activate(params.id))
  api.post('/api/plugins/:id/disable', { perm: 'plugins:manage', audit: 'plugin.disable', params: IdParams }, ({ params }) => s.plugins.deactivate(params.id))
  api.delete('/api/plugins/:id', { perm: 'plugins:manage', audit: 'plugin.uninstall', params: IdParams }, ({ params }) => s.plugins.uninstall(params.id))

  // ------------------------------------------------------------------ MCP
  api.get('/api/mcp/servers', { perm: 'mcp:read' }, () => s.mcp.list())
  api.get('/api/mcp/servers/:id', { perm: 'mcp:read', params: IdParams }, ({ params }) => s.mcp.get(params.id))
  api.post('/api/mcp/servers', { perm: 'mcp:manage', audit: 'mcp.create', body: McpBody }, async ({ body }) => {
    const rec = s.mcp.create(body)
    return rec.enabled ? s.mcp.connect(rec.id) : rec
  })
  api.patch('/api/mcp/servers/:id', { perm: 'mcp:manage', audit: 'mcp.update', params: IdParams, body: McpBody.partial() }, ({ params, body }) => s.mcp.update(params.id, body))
  api.delete('/api/mcp/servers/:id', { perm: 'mcp:manage', audit: 'mcp.delete', params: IdParams }, ({ params }) => s.mcp.delete(params.id))
  api.post('/api/mcp/servers/:id/connect', { perm: 'mcp:manage', params: IdParams }, ({ params }) => s.mcp.connect(params.id))
  api.post('/api/mcp/servers/:id/disconnect', { perm: 'mcp:manage', params: IdParams }, async ({ params }) => {
    await s.mcp.disconnect(s.mcp.get(params.id).id)
    return s.mcp.get(params.id)
  })
  api.get('/api/mcp/servers/:id/resources', { perm: 'mcp:read', params: IdParams }, ({ params }) => s.mcp.connection(params.id).listResources())
  api.get('/api/mcp/servers/:id/resource', { perm: 'mcp:read', params: IdParams, query: z.object({ uri: z.string().min(1) }) }, ({ params, query }) => s.mcp.connection(params.id).readResource(query.uri))
  api.get('/api/mcp/servers/:id/prompts', { perm: 'mcp:read', params: IdParams }, ({ params }) => s.mcp.connection(params.id).listPrompts())
  api.post('/api/mcp/servers/:id/call', { perm: 'tools:execute', audit: 'mcp.call', params: IdParams, body: z.object({ tool: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) }) }, ({ params, body }) => s.mcp.connection(params.id).callTool(body.tool, body.arguments, AbortSignal.timeout(5 * 60_000)))

  // ---------------------------------------------------------------- tasks
  api.get('/api/tasks', { perm: 'tasks:read', query: z.object({ projectId: z.string().optional(), status: z.enum(['pending', 'ready', 'running', 'completed', 'failed', 'cancelled', 'blocked']).optional(), standalone: z.coerce.boolean().optional(), limit: z.coerce.number().int().max(1000).optional() }) }, ({ query }) => s.tasks.list({ projectId: query.projectId, status: query.status, teamRunId: query.standalone ? null : undefined, limit: query.limit }))
  api.get('/api/tasks/:id', { perm: 'tasks:read', params: IdParams }, ({ params }) => s.tasks.get(params.id))
  api.post('/api/tasks', { perm: 'tasks:write', body: TaskBody }, ({ body, principal }) => {
    if (body.projectId) s.projectAccess.require(principal, body.projectId, 'editor')
    return s.tasks.create(body, principal.user.id)
  })
  api.patch('/api/tasks/:id', { perm: 'tasks:write', params: IdParams, body: TaskBody.partial().extend({ status: z.enum(['pending', 'ready', 'cancelled']).optional() }) }, ({ params, body }) => s.tasks.update(params.id, body))
  api.delete('/api/tasks/:id', { perm: 'tasks:write', params: IdParams }, ({ params }) => s.tasks.delete(params.id))
  api.post('/api/tasks/:id/run', { perm: 'agents:run', audit: 'task.run', params: IdParams, body: z.object({ agent: z.string().optional(), wait: z.boolean().optional() }) }, async ({ params, body, principal }) => {
    const t = s.tasks.get(params.id)
    if (t.projectId) s.projectAccess.require(principal, t.projectId, 'editor')
    const p = s.tasks.runTask(params.id, { agent: body.agent, userId: principal.user.id })
    if (body.wait) return p
    p.catch(() => undefined)
    await new Promise((r) => setTimeout(r, 50))
    return s.tasks.get(params.id)
  })
  api.post('/api/tasks/tick', { perm: 'tasks:write' }, () => s.tasks.tick())

  // ------------------------------------------------------------- settings
  api.get('/api/settings', { perm: 'settings:read' }, () => s.settings.all())
  api.put('/api/settings', { perm: 'settings:write', audit: 'settings.update', body: z.record(z.string(), z.unknown()) }, ({ body }) => s.settings.setMany(body))

  // ------------------------------------------------- monitoring & logging
  api.get('/api/monitoring/overview', { perm: 'monitoring:read' }, () => {
    const mem = process.memoryUsage()
    const runStats = s.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM agent_runs WHERE created_at >= datetime('now', '-1 day') GROUP BY status")
    const tokens = s.db.get<{ tin: number | null; tout: number | null; req: number }>("SELECT SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, COUNT(*) AS req FROM llm_usage WHERE created_at >= datetime('now', '-1 day')")
    return {
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: s.startedAt,
      node: process.version,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      cpu: { cores: os.cpus().length, load: os.loadavg() },
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, systemFree: os.freemem(), systemTotal: os.totalmem() },
      database: { sizeBytes: s.db.sizeBytes(), path: s.config.databasePath === ':memory:' ? ':memory:' : 'data/tradezone.db' },
      runs: { active: s.runner.activeRunIds.length, queued: s.runner.queuedCount, last24h: Object.fromEntries(runStats.map((r) => [r.status, r.n])) },
      llm: { requests24h: tokens?.req ?? 0, tokensIn24h: tokens?.tin ?? 0, tokensOut24h: tokens?.tout ?? 0 },
      tools: { registered: s.registry.list().length, calls: s.metrics.toolCalls.total() },
      counts: {
        users: s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0,
        projects: s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM projects WHERE archived = 0')?.n ?? 0,
        agents: s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agents')?.n ?? 0,
        tasksOpen: s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending','ready','running')")?.n ?? 0,
        memories: s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memories')?.n ?? 0,
        mcpConnected: s.mcp.list().filter((m) => m.status === 'connected').length,
        pendingApprovals: s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")?.n ?? 0,
      },
      wsConnections: s.metrics.wsConnections.get(),
      terminals: s.metrics.terminalSessions.get(),
    }
  })
  api.get('/api/monitoring/metrics', { perm: 'monitoring:read' }, () => s.metricsRegistry.toJSON())
  api.get('/api/monitoring/timeseries', { perm: 'monitoring:read', query: z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }) }, ({ query }) => {
    const since = new Date(Date.now() - query.hours * 3_600_000).toISOString()
    return {
      runs: s.db.all("SELECT substr(created_at, 1, 13) AS hour, status, COUNT(*) AS n FROM agent_runs WHERE created_at >= ? GROUP BY hour, status ORDER BY hour", [since]),
      llm: s.db.all('SELECT substr(created_at, 1, 13) AS hour, COUNT(*) AS requests, SUM(tokens_in + tokens_out) AS tokens, AVG(latency_ms) AS latency FROM llm_usage WHERE created_at >= ? GROUP BY hour ORDER BY hour', [since]),
      tools: s.db.all('SELECT substr(created_at, 1, 13) AS hour, COUNT(*) AS calls, SUM(is_error) AS errors FROM tool_calls WHERE created_at >= ? GROUP BY hour ORDER BY hour', [since]),
    }
  })
  api.get('/api/logs', { perm: 'logs:read', query: z.object({ level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(), module: z.string().optional(), search: z.string().optional(), limit: z.coerce.number().int().max(2000).optional(), source: z.enum(['memory', 'db']).optional() }) }, ({ query }) => {
    if (query.source === 'db') {
      return s.db.all(`SELECT id, level, module, msg, context, created_at AS time FROM logs ${query.level ? "WHERE level IN ('warn','error') AND (? = 'warn' OR level = 'error')" : ''} ORDER BY id DESC LIMIT ?`, query.level ? [query.level, query.limit ?? 500] : [query.limit ?? 500])
    }
    return logHub.recent(query)
  })
  api.get('/api/audit', { perm: 'users:manage', query: z.object({ userId: z.string().optional(), action: z.string().optional(), limit: z.coerce.number().int().max(1000).optional(), before: z.coerce.number().int().optional() }) }, ({ query }) => s.audit.list(query))
  api.get('/api/system/info', { perm: null }, () => ({
    version: '1.0.0',
    modules: 40,
    routes: api.count,
    tools: s.registry.list().length,
    providers: s.providers.list().filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name, kind: p.kind, hasApiKey: p.hasApiKey, defaultModel: p.defaultModel })),
    omaEngine: true,
  }))
  api.get('/api/system/routes', { perm: 'settings:read' }, () => api.routes)
}
