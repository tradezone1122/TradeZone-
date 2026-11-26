import { z } from 'zod'
import type { Api, RouteContext } from '../http.js'
import { IdParams } from '../http.js'
import { ForbiddenError, ValidationError } from '../../core/errors.js'
import type { AuthPrincipal } from '../../auth/auth-service.js'
import type { PlatformServices } from '../../platform.js'

const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
const ApprovalMode = z.enum(['auto', 'ask-writes', 'ask-all', 'readonly'])
const AgentBody = z.object({
  name: z.string(),
  role: z.string().max(40).optional(),
  description: z.string().max(2000).nullish(),
  systemPrompt: z.string().min(1).max(50_000),
  model: z.string().max(200).nullish(),
  tools: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  temperature: z.number().min(0).max(2).nullish(),
  effort: Effort.nullish(),
  approvalMode: ApprovalMode.optional(),
  skills: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
})

/** Resolve a project the principal can at least edit (agents can write files). */
export function projectRef(s: PlatformServices, principal: AuthPrincipal, projectId?: string | null) {
  if (!projectId) return undefined
  const p = s.projects.get(projectId)
  s.projectAccess.require(principal, p.id, 'editor')
  return { id: p.id, name: p.name, rootPath: p.rootPath, instructions: p.settings.instructions }
}

function ownRun(ctx: RouteContext<any, any, { id: string }>) {
  const run = ctx.services.runner.getRun(ctx.params.id)
  if (run.userId !== ctx.principal.user.id && ctx.principal.user.role !== 'admin') throw new ForbiddenError('Not your run')
  return run
}

export function agentRoutes(api: Api): void {
  const s = api.services

  // -------------------------------------------------------------- agents
  api.get('/api/agents', { perm: 'agents:read' }, () => s.agents.list())
  api.get('/api/agents/:id', { perm: 'agents:read', params: IdParams }, ({ params }) => s.agents.get(params.id))
  api.post('/api/agents', { perm: 'agents:write', audit: 'agent.create', body: AgentBody }, ({ body }) => s.agents.create(body))
  api.patch('/api/agents/:id', { perm: 'agents:write', audit: 'agent.update', params: IdParams, body: AgentBody.partial() }, ({ params, body }) => s.agents.update(params.id, body))
  api.delete('/api/agents/:id', { perm: 'agents:write', audit: 'agent.delete', params: IdParams }, ({ params }) => s.agents.delete(params.id))
  api.post('/api/agents/:id/clone', { perm: 'agents:write', params: IdParams, body: z.object({ name: z.string() }) }, ({ params, body }) => s.agents.clone(params.id, body.name))
  api.get('/api/agents/:id/tools', { perm: 'agents:read', params: IdParams, query: z.object({ project: z.coerce.boolean().optional() }) }, ({ params, query }) => {
    const a = s.agents.get(params.id)
    return s.registry.select(a.tools, { hasProject: query.project ?? true }).map((t) => s.registry.info(t))
  })

  api.post(
    '/api/agents/:id/run',
    { perm: 'agents:run', audit: 'agent.run', params: IdParams, body: z.object({ input: z.string().min(1).max(200_000), projectId: z.string().nullish(), model: z.string().optional(), wait: z.boolean().optional(), maxTurns: z.number().int().min(1).max(200).optional() }) },
    async ({ params, body, principal }) => {
      const agent = s.agents.get(params.id)
      if (!agent.enabled) throw new ValidationError(`Agent '${agent.name}' is disabled`)
      const { runId, done } = s.runner.start({ agent, input: body.input, userId: principal.user.id, project: projectRef(s, principal, body.projectId), model: body.model, maxTurns: body.maxTurns })
      if (body.wait) return (await done).run
      return { runId }
    },
  )

  // ---------------------------------------------------------------- runs
  api.get('/api/runs', { perm: 'agents:read', query: z.object({ status: z.string().optional(), agent: z.string().optional(), projectId: z.string().optional(), teamRunId: z.string().optional(), limit: z.coerce.number().int().max(500).optional(), mine: z.coerce.boolean().optional() }) }, ({ query, principal }) =>
    s.runner.listRuns({ ...query, userId: principal.user.role === 'admin' && !query.mine ? undefined : principal.user.id }),
  )
  api.get('/api/runs/active', { perm: 'agents:read' }, () => ({ active: s.runner.activeRunIds, queued: s.runner.queuedCount }))
  api.get('/api/runs/:id', { perm: 'agents:read', params: IdParams }, (ctx) => ownRun(ctx))
  api.get('/api/runs/:id/events', { perm: 'agents:read', params: IdParams, query: z.object({ after: z.coerce.number().int().optional() }) }, (ctx) => {
    ownRun(ctx)
    return s.runner.events(ctx.params.id, ctx.query.after ?? 0)
  })
  api.get('/api/runs/:id/tool-calls', { perm: 'agents:read', params: IdParams }, (ctx) => {
    ownRun(ctx)
    return s.db.all('SELECT id, tool, input, output, is_error, duration_ms, created_at FROM tool_calls WHERE run_id = ? ORDER BY created_at', [ctx.params.id])
  })
  api.post('/api/runs/:id/cancel', { perm: 'agents:run', params: IdParams }, (ctx) => {
    ownRun(ctx)
    return { cancelled: s.runner.cancel(ctx.params.id) }
  })

  // -------------------------------------------------------- conversations
  api.get('/api/conversations', { perm: 'agents:read', query: z.object({ projectId: z.string().optional() }) }, ({ principal, query }) => s.conversations.list(principal.user.id, query.projectId))
  api.post('/api/conversations', { perm: 'agents:run', body: z.object({ title: z.string().max(200).optional(), projectId: z.string().nullish(), agent: z.string().nullish(), model: z.string().nullish() }) }, ({ principal, body }) => {
    if (body.projectId) s.projectAccess.require(principal, body.projectId, 'viewer')
    const agentId = body.agent ? s.agents.get(body.agent).id : s.agents.get(s.settings.get<string>('agents.defaultAgent')).id
    return s.conversations.create(principal.user.id, { title: body.title, projectId: body.projectId, agentId, model: body.model })
  })
  api.get('/api/conversations/:id', { perm: 'agents:read', params: IdParams }, ({ params, principal }) => ({ ...s.conversations.get(params.id, principal.user.id, principal.user.role === 'admin'), messages: s.conversations.messages(params.id) }))
  api.patch('/api/conversations/:id', { perm: 'agents:run', params: IdParams, body: z.object({ title: z.string().max(200).optional(), agent: z.string().nullish(), model: z.string().nullish(), projectId: z.string().nullish() }) }, ({ params, principal, body }) => {
    if (body.projectId) s.projectAccess.require(principal, body.projectId, 'viewer')
    return s.conversations.update(params.id, principal.user.id, { title: body.title, agentId: body.agent === undefined ? undefined : body.agent ? s.agents.get(body.agent).id : null, model: body.model, projectId: body.projectId })
  })
  api.delete('/api/conversations/:id', { perm: 'agents:run', params: IdParams }, ({ params, principal }) => s.conversations.delete(params.id, principal.user.id, principal.user.role === 'admin'))
  api.post('/api/conversations/:id/messages', { perm: 'agents:run', params: IdParams, body: z.object({ content: z.string().min(1).max(200_000), wait: z.boolean().optional() }) }, async ({ params, principal, body }) => {
    const conv = s.conversations.get(params.id, principal.user.id)
    const agent = s.agents.get(conv.agentId ?? s.settings.get<string>('agents.defaultAgent'))
    const history = s.conversations.history(conv.id)
    if (!history.length) s.conversations.autoTitle(conv.id, body.content)
    const { runId, done } = s.runner.start({ agent, input: body.content, userId: principal.user.id, project: projectRef(s, principal, conv.projectId), conversationId: conv.id, history, model: conv.model ?? undefined })
    if (body.wait) return (await done).run
    return { runId }
  })

  // ---------------------------------------------------------------- teams
  api.get('/api/teams', { perm: 'agents:read' }, () => s.orchestrator.listTeams())
  api.get('/api/teams/:id', { perm: 'agents:read', params: IdParams }, ({ params }) => s.orchestrator.getTeam(params.id))
  const TeamBody = z.object({ name: z.string().min(1).max(60), description: z.string().max(2000).optional(), coordinator: z.string().optional(), members: z.array(z.string()).min(1), maxParallel: z.number().int().min(1).max(8).optional() })
  api.post('/api/teams', { perm: 'agents:write', audit: 'team.create', body: TeamBody }, ({ body }) => s.orchestrator.createTeam(body))
  api.patch('/api/teams/:id', { perm: 'agents:write', audit: 'team.update', params: IdParams, body: TeamBody.partial() }, ({ params, body }) => s.orchestrator.updateTeam(params.id, body))
  api.delete('/api/teams/:id', { perm: 'agents:write', audit: 'team.delete', params: IdParams }, ({ params }) => s.orchestrator.deleteTeam(params.id))
  api.post('/api/teams/:id/run', { perm: 'agents:run', audit: 'team.run', params: IdParams, body: z.object({ goal: z.string().min(3).max(100_000), engine: z.enum(['native', 'oma']).optional(), projectId: z.string().nullish(), wait: z.boolean().optional() }) }, async ({ params, body, principal }) => {
    const { teamRunId, done } = s.orchestrator.start({ team: params.id, goal: body.goal, engine: body.engine, userId: principal.user.id, project: projectRef(s, principal, body.projectId) })
    if (body.wait) return done
    return { teamRunId }
  })
  api.get('/api/team-runs', { perm: 'agents:read', query: z.object({ limit: z.coerce.number().int().max(200).optional() }) }, ({ query }) => s.orchestrator.listRuns(query.limit))
  api.get('/api/team-runs/:id', { perm: 'agents:read', params: IdParams }, ({ params }) => s.orchestrator.getRun(params.id))
  api.get('/api/team-runs/:id/messages', { perm: 'agents:read', params: IdParams }, ({ params }) => s.messaging.history({ teamRunId: params.id }))
  api.post('/api/team-runs/:id/cancel', { perm: 'agents:run', params: IdParams }, ({ params }) => ({ cancelled: s.orchestrator.cancel(params.id) }))

  // ------------------------------------------------------ agent messaging
  api.get('/api/agent-messages', { perm: 'agents:read', query: z.object({ agent: z.string().optional(), channel: z.string().optional(), limit: z.coerce.number().int().max(1000).optional() }) }, ({ query }) => s.messaging.history(query))
  api.post('/api/agent-messages', { perm: 'agents:run', body: z.object({ to: z.string().optional(), content: z.string().min(1), teamRunId: z.string().optional() }) }, ({ body, principal }) => s.messaging.send({ from: `user:${principal.user.username}`, to: body.to ?? null, teamRunId: body.teamRunId ?? null, content: body.content }))

  // ------------------------------------------------------------ approvals
  api.get('/api/approvals', { perm: 'agents:read', query: z.object({ status: z.enum(['pending', 'approved', 'denied', 'expired']).optional() }) }, ({ query }) => s.approvals.list(query.status))
  api.post('/api/approvals/:id/decision', { perm: 'approvals:decide', audit: 'approval.decide', params: IdParams, body: z.object({ approve: z.boolean() }) }, ({ params, body, principal }) => {
    const a = s.approvals.get(params.id)
    if (a.userId && a.userId !== principal.user.id && principal.user.role !== 'admin') throw new ForbiddenError('Only the run owner or an admin can decide this approval')
    return s.approvals.decide(params.id, body.approve, principal.user.id)
  })
}
