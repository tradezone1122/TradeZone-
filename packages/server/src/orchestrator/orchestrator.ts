/**
 * Module 03: Multi-Agent Orchestrator
 *
 * Teams are named groups of agents with a coordinator. A team run takes a
 * goal and executes it with one of two engines:
 *
 *  - "native": the coordinator plans a task DAG (planning engine), tasks are
 *    persisted (task engine tables) and executed by the agent runtime with
 *    dependency outputs injected, independent tasks running in parallel up to
 *    `maxParallel`; failures block dependents and trigger one replanning
 *    round; finally the coordinator synthesizes the result.
 *
 *  - "oma": the vendored open-multi-agent runtime (MIT) runs the team with
 *    its own coordinator/scheduler. Platform model providers are bridged in
 *    through an LLMAdapter and platform tools through OMA custom tools, so
 *    approvals, sandboxing and auditing still apply.
 */
import { z } from 'zod'
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { EventBus } from '../events/bus.js'
import type { AgentRunner, RunOutcome } from '../agents/runner.js'
import type { AgentDefinition, AgentService } from '../agents/agent-service.js'
import type { AIRouter } from '../router/ai-router.js'
import type { Planner, Plan, PlanTask, RosterEntry } from '../planning/planner.js'
import type { AgentMessaging } from '../comms/agent-messaging.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolExecutor } from '../tools/executor.js'
import type { Logger } from '../logging/logger.js'
import type { ChatMessage, ContentBlock } from '../core/types.js'
import { textOf } from '../core/types.js'
import { SYNTHESIS_PROMPT } from '../prompts/roles.js'
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js'

export interface Team {
  id: string
  name: string
  description: string | null
  coordinatorAgentId: string | null
  memberAgentIds: string[]
  maxParallel: number
  createdAt: string
  updatedAt: string
}

export interface TeamRun {
  id: string
  teamId: string | null
  engine: 'native' | 'oma'
  userId: string | null
  projectId: string | null
  goal: string
  plan: Plan | null
  status: 'planning' | 'running' | 'synthesizing' | 'completed' | 'failed' | 'cancelled'
  result: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

interface TeamRow {
  id: string
  name: string
  description: string | null
  coordinator_agent_id: string | null
  member_agent_ids: string
  max_parallel: number
  created_at: string
  updated_at: string
}

interface TeamRunRow {
  id: string
  team_id: string | null
  engine: 'native' | 'oma'
  user_id: string | null
  project_id: string | null
  goal: string
  plan: string | null
  status: TeamRun['status']
  result: string | null
  error: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

const toTeam = (r: TeamRow): Team => ({ id: r.id, name: r.name, description: r.description, coordinatorAgentId: r.coordinator_agent_id, memberAgentIds: parseJson(r.member_agent_ids, []), maxParallel: r.max_parallel, createdAt: r.created_at, updatedAt: r.updated_at })
const toTeamRun = (r: TeamRunRow): TeamRun => ({ id: r.id, teamId: r.team_id, engine: r.engine, userId: r.user_id, projectId: r.project_id, goal: r.goal, plan: parseJson<Plan | null>(r.plan, null), status: r.status, result: r.result, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at })

export interface ProjectRef {
  id: string
  name: string
  rootPath: string
  instructions?: string
}

export interface OrchestratorDeps {
  db: Database
  bus: EventBus
  runner: AgentRunner
  agents: AgentService
  router: AIRouter
  planner: Planner
  messaging: AgentMessaging
  registry: ToolRegistry
  executor: ToolExecutor
  log: Logger
  services: () => import('../platform.js').PlatformServices
  repoContext: (root: string) => Promise<string>
}

export class Orchestrator {
  private controllers = new Map<string, AbortController>()

  constructor(private readonly d: OrchestratorDeps) {}

  // ---------------------------------------------------------------- teams
  listTeams(): Team[] {
    return this.d.db.all<TeamRow>('SELECT * FROM teams ORDER BY name').map(toTeam)
  }

  getTeam(idOrName: string): Team {
    const r = this.d.db.get<TeamRow>('SELECT * FROM teams WHERE id = ? OR name = ?', [idOrName, idOrName])
    if (!r) throw new NotFoundError('Team')
    return toTeam(r)
  }

  createTeam(input: { name: string; description?: string; coordinator?: string; members: string[]; maxParallel?: number }): Team {
    if (!input.name.trim()) throw new ValidationError('Team name is required')
    if (this.d.db.get('SELECT id FROM teams WHERE name = ?', [input.name])) throw new ConflictError('Team name already exists')
    if (!input.members.length) throw new ValidationError('A team needs at least one member agent')
    const memberIds = input.members.map((m) => this.d.agents.get(m).id)
    const coordinator = this.d.agents.get(input.coordinator ?? 'planner')
    const ts = now()
    const id = newId('team')
    this.d.db.insert('teams', { id, name: input.name, description: input.description ?? null, coordinator_agent_id: coordinator.id, member_agent_ids: JSON.stringify(memberIds), max_parallel: Math.max(1, Math.min(8, input.maxParallel ?? 3)), created_at: ts, updated_at: ts })
    return this.getTeam(id)
  }

  updateTeam(id: string, patch: { name?: string; description?: string | null; coordinator?: string; members?: string[]; maxParallel?: number }): Team {
    const t = this.getTeam(id)
    const row: Record<string, unknown> = { updated_at: now() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.description !== undefined) row.description = patch.description
    if (patch.coordinator !== undefined) row.coordinator_agent_id = this.d.agents.get(patch.coordinator).id
    if (patch.members !== undefined) row.member_agent_ids = JSON.stringify(patch.members.map((m) => this.d.agents.get(m).id))
    if (patch.maxParallel !== undefined) row.max_parallel = Math.max(1, Math.min(8, patch.maxParallel))
    this.d.db.update('teams', t.id, row)
    return this.getTeam(t.id)
  }

  deleteTeam(id: string): void {
    const t = this.getTeam(id)
    this.d.db.run('DELETE FROM teams WHERE id = ?', [t.id])
  }

  // ------------------------------------------------------------ team runs
  listRuns(limit = 50): TeamRun[] {
    return this.d.db.all<TeamRunRow>('SELECT * FROM team_runs ORDER BY created_at DESC LIMIT ?', [limit]).map(toTeamRun)
  }

  getRun(id: string): TeamRun & { tasks: unknown[]; agentRuns: unknown[] } {
    const r = this.d.db.get<TeamRunRow>('SELECT * FROM team_runs WHERE id = ?', [id])
    if (!r) throw new NotFoundError('Team run')
    const tasks = this.d.db.all('SELECT id, title, description, status, assignee_agent_id, depends_on, result, error, run_id, started_at, finished_at FROM tasks WHERE team_run_id = ? ORDER BY created_at', [id]).map((t: any) => ({ ...t, depends_on: parseJson(t.depends_on, []) }))
    return { ...toTeamRun(r), tasks, agentRuns: this.d.runner.listRuns({ teamRunId: id, limit: 200 }) }
  }

  cancel(id: string): boolean {
    const c = this.controllers.get(id)
    if (!c) return false
    c.abort()
    return true
  }

  /** Start a team run in the background; returns the run id immediately. */
  start(input: { team: string; goal: string; engine?: 'native' | 'oma'; userId?: string; project?: ProjectRef }): { teamRunId: string; done: Promise<TeamRun> } {
    const team = this.getTeam(input.team)
    if (!input.goal.trim()) throw new ValidationError('Goal is required')
    const id = newId('trun')
    this.d.db.insert('team_runs', { id, team_id: team.id, engine: input.engine ?? 'native', user_id: input.userId ?? null, project_id: input.project?.id ?? null, goal: input.goal, plan: null, status: 'planning', started_at: now(), created_at: now() })
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const exec = input.engine === 'oma' ? this.executeOma(id, team, input, controller.signal) : this.executeNative(id, team, input, controller.signal)
    const done = exec
      .catch((err) => {
        const cancelled = controller.signal.aborted
        this.d.db.update('team_runs', id, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err), finished_at: now() })
        this.publish(id, cancelled ? 'team.cancelled' : 'team.failed', { error: cancelled ? 'Cancelled' : String(err instanceof Error ? err.message : err) })
        return toTeamRun(this.d.db.get<TeamRunRow>('SELECT * FROM team_runs WHERE id = ?', [id])!)
      })
      .finally(() => this.controllers.delete(id))
    return { teamRunId: id, done }
  }

  private publish(teamRunId: string, type: string, data: unknown): void {
    this.d.bus.publish(`team:${teamRunId}`, type, data)
    this.d.bus.publish('teams', type, { teamRunId, ...((data ?? {}) as object) })
  }

  private roster(team: Team): Array<RosterEntry & { agent: AgentDefinition }> {
    return team.memberAgentIds.map((id) => {
      const agent = this.d.agents.get(id)
      return { name: agent.name, role: agent.role, description: agent.description, capabilities: agent.capabilities, agent }
    })
  }

  private async executeNative(id: string, team: Team, input: { goal: string; userId?: string; project?: ProjectRef }, signal: AbortSignal): Promise<TeamRun> {
    const { db, planner, runner, router, messaging } = this.d
    const roster = this.roster(team)
    const coordinator = team.coordinatorAgentId ? this.d.agents.get(team.coordinatorAgentId) : roster[0]!.agent
    this.publish(id, 'team.planning', { goal: input.goal })
    const repo = input.project ? await this.d.repoContext(input.project.rootPath).catch(() => '') : ''
    let plan = await planner.plan(input.goal, roster, { model: coordinator.model, context: repo, signal, userId: input.userId })
    db.update('team_runs', id, { plan: JSON.stringify(plan), status: 'running' })
    this.publish(id, 'team.plan', plan)
    messaging.send({ from: coordinator.name, teamRunId: id, content: `Plan: ${plan.summary}\n${plan.tasks.map((t) => `- [${t.id}] ${t.title} → ${t.assignee}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}`).join('\n')}` })

    const results: Record<string, { status: string; output: string; runId?: string }> = {}
    await this.executePlan(id, team, plan, roster, input, results, signal)

    const failed = plan.tasks.filter((t) => results[t.id]?.status !== 'completed')
    if (failed.length && !signal.aborted) {
      this.publish(id, 'team.replanning', { failed: failed.map((t) => t.id) })
      try {
        const next = await planner.replan(input.goal, roster, plan, results, { model: coordinator.model, signal, userId: input.userId })
        const prefixed = { ...next, tasks: next.tasks.map((t) => ({ ...t, id: `r_${t.id}`, dependsOn: t.dependsOn.map((dd) => `r_${dd}`) })) }
        plan = { summary: `${plan.summary}\n\nReplan: ${next.summary}`, tasks: [...plan.tasks, ...prefixed.tasks] }
        db.update('team_runs', id, { plan: JSON.stringify(plan) })
        this.publish(id, 'team.plan', plan)
        await this.executePlan(id, team, prefixed, roster, input, results, signal)
      } catch (err) {
        this.d.log.warn('Replanning failed', { teamRunId: id, error: err })
      }
    }
    if (signal.aborted) throw new Error('Cancelled')

    db.update('team_runs', id, { status: 'synthesizing' })
    this.publish(id, 'team.synthesizing', {})
    const report = plan.tasks.map((t) => `### ${t.id}: ${t.title} (${t.assignee}) — ${results[t.id]?.status ?? 'not run'}\n${(results[t.id]?.output ?? '').slice(0, 6000)}`).join('\n\n')
    let final: string
    try {
      const res = await router.chat(coordinator.model, { system: SYNTHESIS_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: `Goal:\n${input.goal}\n\nTask results:\n${report}` }] }], maxTokens: 8000, signal }, { userId: input.userId })
      final = textOf(res.content)
    } catch (err) {
      final = `Synthesis failed (${err instanceof Error ? err.message : String(err)}). Raw task results:\n\n${report}`
    }
    const replanned = plan.tasks.filter((t) => t.id.startsWith('r_'))
    const decisive = replanned.length ? replanned : plan.tasks
    const allOk = decisive.every((t) => results[t.id]?.status === 'completed')
    db.update('team_runs', id, { status: allOk ? 'completed' : 'failed', result: final, error: allOk ? null : 'Some tasks did not complete', finished_at: now() })
    this.publish(id, 'team.completed', { result: final, ok: allOk })
    return toTeamRun(db.get<TeamRunRow>('SELECT * FROM team_runs WHERE id = ?', [id])!)
  }

  /** Event-driven DAG execution: a task starts as soon as all its dependencies completed. */
  private async executePlan(teamRunId: string, team: Team, plan: Plan, roster: Array<RosterEntry & { agent: AgentDefinition }>, input: { goal: string; userId?: string; project?: ProjectRef }, results: Record<string, { status: string; output: string; runId?: string }>, signal: AbortSignal): Promise<void> {
    const { db, runner, messaging } = this.d
    const taskRowIds = new Map<string, string>()
    const ts = now()
    for (const t of plan.tasks) {
      const rowId = newId('task')
      taskRowIds.set(t.id, rowId)
      const agent = roster.find((r) => r.name === t.assignee)?.agent
      db.insert('tasks', { id: rowId, project_id: input.project?.id ?? null, team_run_id: teamRunId, title: `[${t.id}] ${t.title}`, description: t.description, status: t.dependsOn.length ? 'pending' : 'ready', priority: 0, assignee_agent_id: agent?.id ?? null, depends_on: JSON.stringify(t.dependsOn.map((d) => taskRowIds.get(d) ?? d)), attempts: 0, max_attempts: 1, auto_run: 0, created_by: input.userId ?? null, created_at: ts, updated_at: ts })
    }
    // Resolve dependency ids that referenced later tasks.
    for (const t of plan.tasks) db.update('tasks', taskRowIds.get(t.id)!, { depends_on: JSON.stringify(t.dependsOn.map((d) => taskRowIds.get(d) ?? d)) })

    const pending = new Map(plan.tasks.map((t) => [t.id, t]))
    const running = new Map<string, Promise<void>>()
    const isDone = (id: string) => results[id]?.status === 'completed'
    const isBlocked = (t: PlanTask) => t.dependsOn.some((d) => results[d] && results[d]!.status !== 'completed')

    const launch = (t: PlanTask) => {
      pending.delete(t.id)
      const agent = roster.find((r) => r.name === t.assignee)!.agent
      const rowId = taskRowIds.get(t.id)!
      const depContext = t.dependsOn.length
        ? `## Results from prerequisite tasks\n${t.dependsOn.map((d) => `### ${d}: ${plan.tasks.find((x) => x.id === d)?.title ?? d}\n${(results[d]?.output ?? '').slice(0, 8000)}`).join('\n\n')}`
        : undefined
      const teamContext = `## Team context\nYou are part of team "${team.name}" working on the overall goal:\n${input.goal}\n\nYour task is ${t.id}: "${t.title}". Focus only on your task; other agents handle the rest. Use send_message to share important findings with teammates.`
      db.update('tasks', rowId, { status: 'running', started_at: now(), updated_at: now() })
      this.publish(teamRunId, 'task.started', { taskId: t.id, title: t.title, agent: agent.name })
      const { runId, done } = runner.start({
        agent,
        input: `${t.title}\n\n${t.description}`,
        userId: input.userId,
        project: input.project,
        teamRunId,
        taskId: rowId,
        extraContext: [teamContext, depContext].filter(Boolean).join('\n\n'),
        signal,
      })
      db.update('tasks', rowId, { run_id: runId })
      const p = done.then((outcome: RunOutcome) => {
        const ok = outcome.run.status === 'completed'
        results[t.id] = { status: outcome.run.status, output: outcome.run.output ?? outcome.run.error ?? '', runId }
        db.update('tasks', rowId, { status: ok ? 'completed' : 'failed', result: outcome.run.output, error: outcome.run.error, finished_at: now(), updated_at: now() })
        this.publish(teamRunId, 'task.finished', { taskId: t.id, status: outcome.run.status, runId })
        messaging.send({ from: agent.name, teamRunId, content: `Finished ${t.id} (${outcome.run.status}): ${(outcome.run.output ?? outcome.run.error ?? '').slice(0, 1500)}` })
      })
      running.set(t.id, p.finally(() => running.delete(t.id)))
    }

    while (pending.size || running.size) {
      if (signal.aborted) break
      for (const t of [...pending.values()]) {
        if (isBlocked(t)) {
          pending.delete(t.id)
          results[t.id] = { status: 'blocked', output: `Blocked: prerequisite failed (${t.dependsOn.filter((d) => !isDone(d)).join(', ')})` }
          db.update('tasks', taskRowIds.get(t.id)!, { status: 'blocked', error: results[t.id]!.output, updated_at: now() })
          this.publish(teamRunId, 'task.finished', { taskId: t.id, status: 'blocked' })
        }
      }
      const ready = [...pending.values()].filter((t) => t.dependsOn.every(isDone))
      for (const t of ready) {
        if (running.size >= team.maxParallel) break
        launch(t)
      }
      if (!running.size) {
        if (pending.size) {
          // Remaining tasks can never become ready (should not happen after validation).
          for (const t of pending.values()) results[t.id] = { status: 'blocked', output: 'Unsatisfiable dependencies' }
          pending.clear()
        }
        break
      }
      await Promise.race(running.values())
    }
    await Promise.allSettled(running.values())
  }

  // --------------------------------------------------------- OMA engine
  private async executeOma(id: string, team: Team, input: { goal: string; userId?: string; project?: ProjectRef }, signal: AbortSignal): Promise<TeamRun> {
    const { db, router, registry, executor } = this.d
    let oma: typeof import('@open-multi-agent/core')
    try {
      oma = await import('@open-multi-agent/core')
    } catch (err) {
      throw new ValidationError(`The open-multi-agent engine is not built. Run "npm run build:oma". (${err instanceof Error ? err.message : String(err)})`)
    }
    const roster = this.roster(team)
    db.update('team_runs', id, { status: 'running' })
    this.publish(id, 'team.started', { engine: 'oma' })

    const services = this.d.services()
    const makeAdapter = (modelRef: string | null) => ({
      name: 'tradezone-router',
      async chat(messages: any[], options: any) {
        const res = await router.chat(modelRef, { system: options.systemPrompt, messages: fromOmaMessages(messages), tools: (options.tools ?? []).map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), maxTokens: options.maxTokens, signal: options.abortSignal ?? signal }, { userId: input.userId })
        return { id: res.id, content: toOmaContent(res.content), model: res.model, stop_reason: res.stopReason, usage: { input_tokens: res.usage.inputTokens, output_tokens: res.usage.outputTokens } }
      },
      async *stream(messages: any[], options: any) {
        const res = await this.chat(messages, options)
        const text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
        if (text) yield { type: 'text', data: text }
        yield { type: 'done', data: res }
      },
    })

    const bridgeTools = (agent: AgentDefinition) => {
      const tools = registry.select(agent.tools, { hasProject: !!input.project }).filter((t) => t.name !== 'delegate_task')
      const allowed = new Set(tools.map((t) => t.name))
      return tools.map((t) => ({
        name: `tz_${t.name}`.slice(0, 64),
        description: t.description,
        inputSchema: z.record(z.string(), z.unknown()),
        llmInputSchema: registry.info(t).inputSchema,
        consequential: t.permission !== 'read',
        async execute(toolInput: Record<string, unknown>, ctx: any) {
          const r = await executor.execute(
            { type: 'tool_use', id: newId('omatc'), name: t.name, input: toolInput },
            { projectRoot: input.project?.rootPath, projectId: input.project?.id, userId: input.userId, agentName: agent.name, teamRunId: id, signal: ctx?.abortSignal ?? signal, services },
            { approvalMode: agent.approvalMode, allowed },
          )
          return { data: r.content, isError: r.isError }
        },
      }))
    }

    const coordinator = team.coordinatorAgentId ? this.d.agents.get(team.coordinatorAgentId) : roster[0]!.agent
    const orchestrator = new oma.OpenMultiAgent({
      maxConcurrency: team.maxParallel,
      onProgress: (e: { type: string; agent?: string; task?: string; data?: unknown }) => this.publish(id, `oma.${e.type}`, { agent: e.agent, task: e.task, data: safeData(e.data) }),
    } as any)
    const omaTeam = orchestrator.createTeam(team.name, {
      name: team.name,
      sharedMemory: true,
      agents: roster.map((r) => ({
        name: r.agent.name,
        model: r.agent.model ?? 'default',
        systemPrompt: `${r.agent.systemPrompt}\n\nTools are prefixed with "tz_" and operate on the active project.`,
        adapter: makeAdapter(r.agent.model) as any,
        customTools: bridgeTools(r.agent) as any,
        tools: [],
        maxTurns: r.agent.maxTurns,
      })),
    } as any)
    const goal = input.project ? `${input.goal}\n\n(Active project: ${input.project.name}. Use the tz_ tools to inspect and change it.)` : input.goal
    const result: any = await orchestrator.runTeam(omaTeam, goal, { abortSignal: signal, coordinator: { adapter: makeAdapter(coordinator.model), model: coordinator.model ?? 'default' } } as any)
    const outputs: string[] = []
    const agentResults: Map<string, any> | undefined = result?.agentResults
    if (agentResults) for (const [name, r] of agentResults) outputs.push(`### ${name}${r.success ? '' : ' (failed)'}\n${r.output ?? ''}`)
    const final = agentResults?.get('coordinator')?.output ?? outputs.join('\n\n') ?? ''
    const ok = !!result?.success
    db.update('team_runs', id, { status: ok ? 'completed' : 'failed', result: final || outputs.join('\n\n'), error: ok ? null : String(result?.errorInfo?.message ?? 'OMA run did not succeed'), finished_at: now() })
    this.publish(id, 'team.completed', { result: final, ok })
    return toTeamRun(db.get<TeamRunRow>('SELECT * FROM team_runs WHERE id = ?', [id])!)
  }
}

function safeData(d: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(d ?? null, (_k, v) => (typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v)))
  } catch {
    return String(d)
  }
}

/** OMA content blocks → platform blocks (shapes are intentionally compatible). */
export function fromOmaMessages(messages: Array<{ role: 'user' | 'assistant'; content: any[] }>): ChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content
      .map((b: any): ContentBlock | null => {
        if (b.type === 'text') return { type: 'text', text: b.text }
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: String(b.name).replace(/^tz_/, 'tz_'), input: b.input ?? {} }
        if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), is_error: b.is_error }
        if (b.type === 'reasoning') return { type: 'reasoning', text: b.text, signature: b.signature, provenance: b.provenance }
        return null
      })
      .filter((b): b is ContentBlock => b !== null),
  }))
}

export function toOmaContent(blocks: ContentBlock[]): any[] {
  return blocks.map((b) => {
    if (b.type === 'reasoning') return { type: 'reasoning', text: b.text, signature: b.signature, provenance: b.provenance }
    return b
  })
}
