/**
 * Module 02: Agent Runtime
 *
 * Executes an agent against a task: builds context, streams model output,
 * executes tool calls through the tool execution engine, loops until the
 * model finishes (or limits are hit), and persists the run, its events and
 * conversation history. Supports cancellation, concurrency limiting,
 * loop detection, context compaction and sub-agent delegation.
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { EventBus } from '../events/bus.js'
import type { AIRouter } from '../router/ai-router.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolExecutor } from '../tools/executor.js'
import type { ContextManager } from '../context/context-manager.js'
import type { AgentDefinition } from './agent-service.js'
import type { ChatMessage, ContentBlock, ToolUseBlock } from '../core/types.js'
import { estimateTokens, textOf } from '../core/types.js'
import type { PlatformMetrics } from '../monitoring/metrics.js'
import type { Logger } from '../logging/logger.js'
import { NotFoundError } from '../core/errors.js'
import type { ScopeFilter } from '../memory/memory-service.js'

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'

export interface RunRequest {
  agent: AgentDefinition
  input: string
  userId?: string
  project?: { id: string; name: string; rootPath: string; instructions?: string }
  conversationId?: string
  history?: ChatMessage[]
  parentRunId?: string
  teamRunId?: string
  taskId?: string
  /** Extra system prompt section (e.g. dependency outputs from the orchestrator). */
  extraContext?: string
  model?: string
  maxTurns?: number
  depth?: number
  signal?: AbortSignal
}

export interface RunRecord {
  id: string
  agentId: string | null
  agentName: string
  userId: string | null
  projectId: string | null
  conversationId: string | null
  parentRunId: string | null
  teamRunId: string | null
  taskId: string | null
  input: string
  output: string | null
  status: RunStatus
  error: string | null
  model: string | null
  turns: number
  tokensIn: number
  tokensOut: number
  toolCalls: number
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface RunOutcome {
  run: RunRecord
  messages: ChatMessage[]
}

interface RunRow {
  id: string
  agent_id: string | null
  agent_name: string
  user_id: string | null
  project_id: string | null
  conversation_id: string | null
  parent_run_id: string | null
  team_run_id: string | null
  task_id: string | null
  input: string
  output: string | null
  status: RunStatus
  error: string | null
  model: string | null
  turns: number
  tokens_in: number
  tokens_out: number
  tool_calls: number
  started_at: string | null
  finished_at: string | null
  created_at: string
}

export const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  agentId: r.agent_id,
  agentName: r.agent_name,
  userId: r.user_id,
  projectId: r.project_id,
  conversationId: r.conversation_id,
  parentRunId: r.parent_run_id,
  teamRunId: r.team_run_id,
  taskId: r.task_id,
  input: r.input,
  output: r.output,
  status: r.status,
  error: r.error,
  model: r.model,
  turns: r.turns,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  toolCalls: r.tool_calls,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
})

/** Simple FIFO semaphore for limiting concurrent runs. */
export class Semaphore {
  private waiters: Array<() => void> = []
  constructor(private available: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.available > 0) {
      this.available--
      return () => this.release()
    }
    await new Promise<void>((resolve, reject) => {
      const w = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        this.waiters = this.waiters.filter((x) => x !== w)
        reject(new Error('Cancelled while queued'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(w)
    })
    return () => this.release()
  }
  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.available++
  }
  get queued(): number {
    return this.waiters.length
  }
}

export interface RunnerDeps {
  db: Database
  bus: EventBus
  router: AIRouter
  registry: ToolRegistry
  executor: ToolExecutor
  context: ContextManager
  metrics: PlatformMetrics
  log: Logger
  services: () => import('../platform.js').PlatformServices
  maxConcurrentRuns: number
  contextBudgetTokens?: number
}

const MAX_DEPTH = 3

export class AgentRunner {
  private controllers = new Map<string, AbortController>()
  private readonly semaphore: Semaphore

  constructor(private readonly deps: RunnerDeps) {
    this.semaphore = new Semaphore(deps.maxConcurrentRuns)
  }

  get activeRunIds(): string[] {
    return [...this.controllers.keys()]
  }

  get queuedCount(): number {
    return this.semaphore.queued
  }

  getRun(id: string): RunRecord {
    const r = this.deps.db.get<RunRow>('SELECT * FROM agent_runs WHERE id = ?', [id])
    if (!r) throw new NotFoundError('Run')
    return toRun(r)
  }

  listRuns(filter: { status?: string; agent?: string; projectId?: string; teamRunId?: string; userId?: string; limit?: number } = {}): RunRecord[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.status) { where.push('status = ?'); params.push(filter.status) }
    if (filter.agent) { where.push('agent_name = ?'); params.push(filter.agent) }
    if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId) }
    if (filter.teamRunId) { where.push('team_run_id = ?'); params.push(filter.teamRunId) }
    if (filter.userId) { where.push('user_id = ?'); params.push(filter.userId) }
    return this.deps.db
      .all<RunRow>(`SELECT * FROM agent_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`, [...params, filter.limit ?? 100])
      .map(toRun)
  }

  events(runId: string, afterId = 0): Array<{ id: number; type: string; data: unknown; createdAt: string }> {
    return this.deps.db
      .all<{ id: number; type: string; data: string; created_at: string }>('SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT 2000', [runId, afterId])
      .map((e) => ({ id: e.id, type: e.type, data: parseJson(e.data, {}), createdAt: e.created_at }))
  }

  cancel(runId: string): boolean {
    const c = this.controllers.get(runId)
    if (!c) return false
    c.abort()
    return true
  }

  /** Create the run row and start it in the background. Returns immediately. */
  start(req: RunRequest): { runId: string; done: Promise<RunOutcome> } {
    const runId = this.createRunRow(req)
    const done = this.execute(runId, req)
    done.catch(() => undefined)
    return { runId, done }
  }

  /** Run to completion. */
  async run(req: RunRequest): Promise<RunOutcome> {
    return this.start(req).done
  }

  private createRunRow(req: RunRequest): string {
    const id = newId('run')
    this.deps.db.insert('agent_runs', {
      id,
      agent_id: req.agent.id,
      agent_name: req.agent.name,
      user_id: req.userId ?? null,
      project_id: req.project?.id ?? null,
      conversation_id: req.conversationId ?? null,
      parent_run_id: req.parentRunId ?? null,
      team_run_id: req.teamRunId ?? null,
      task_id: req.taskId ?? null,
      input: req.input,
      status: 'queued',
      model: req.model ?? req.agent.model ?? null,
      created_at: now(),
    })
    this.deps.bus.publish('runs', 'run.created', this.getRun(id))
    return id
  }

  private emit(runId: string, type: string, data: unknown, persist = true): void {
    if (persist) {
      try {
        this.deps.db.insert('run_events', { run_id: runId, type, data: JSON.stringify(data), created_at: now() })
      } catch (err) {
        this.deps.log.error('Failed to persist run event', { runId, type, error: err })
      }
    }
    this.deps.bus.publish(`run:${runId}`, type, data)
  }

  private setStatus(runId: string, status: RunStatus, extra: Record<string, unknown> = {}): void {
    this.deps.db.update('agent_runs', runId, { status, ...extra })
    const run = this.getRun(runId)
    this.deps.bus.publish('runs', 'run.updated', run)
    this.emit(runId, 'run.status', { status, error: run.error })
  }

  private async execute(runId: string, req: RunRequest): Promise<RunOutcome> {
    const { db, router, registry, executor, context, metrics, log } = this.deps
    const controller = new AbortController()
    const onParentAbort = () => controller.abort()
    req.signal?.addEventListener('abort', onParentAbort, { once: true })
    this.controllers.set(runId, controller)
    const signal = controller.signal
    let release: (() => void) | undefined
    const messages: ChatMessage[] = [...(req.history ?? [])]
    let tokensIn = 0
    let tokensOut = 0
    let toolCallCount = 0
    let turns = 0
    let modelUsed: string | null = req.model ?? req.agent.model ?? null
    try {
      release = await this.semaphore.acquire(signal)
      metrics.runsActive.inc()
      this.setStatus(runId, 'running', { started_at: now() })

      const agent = req.agent
      const depth = req.depth ?? 0
      const hasProject = !!req.project
      let tools = registry.select(agent.tools, { hasProject })
      if (depth >= MAX_DEPTH) tools = tools.filter((t) => t.name !== 'delegate_task')
      const allowed = new Set(tools.map((t) => t.name))
      const specs = registry.specs(tools)

      const memoryScopes: ScopeFilter[] = [{ scope: 'global' }, { scope: 'agent', scopeId: agent.name }]
      if (req.userId) memoryScopes.push({ scope: 'user', scopeId: req.userId })
      if (req.project) memoryScopes.push({ scope: 'project', scopeId: req.project.id })

      const system = await context.buildSystemPrompt({
        rolePrompt: agent.systemPrompt,
        agentName: agent.name,
        projectName: req.project?.name,
        projectRoot: req.project?.rootPath,
        projectInstructions: req.project?.instructions,
        memoryQuery: req.input,
        memoryScopes,
        skills: agent.skills.length ? agent.skills : undefined,
        extra: req.extraContext,
      })

      messages.push({ role: 'user', content: [{ type: 'text', text: req.input }] })
      this.emit(runId, 'run.started', { agent: agent.name, tools: [...allowed], input: req.input, depth })

      const maxTurns = req.maxTurns ?? agent.maxTurns
      const budget = this.deps.contextBudgetTokens ?? 150_000
      const callCounts = new Map<string, number>()
      let finalText = ''
      let stopNote = ''

      while (turns < maxTurns) {
        if (signal.aborted) throw new Error('Cancelled')
        turns++

        if (estimateTokens(messages) + estimateTokens(system) > budget) {
          const compacted = await context.compact(messages, Math.floor(budget * 0.6), async (transcript) => {
            const res = await router.chat(agent.model, {
              system: 'Summarize this agent transcript for continuation. Preserve: the task, decisions, files touched, commands run and their results, errors, and what remains. Be dense and factual.',
              messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
              maxTokens: 4000,
              effort: 'low',
              signal,
            }, { runId, userId: req.userId })
            return textOf(res.content)
          })
          if (compacted.compacted) {
            messages.splice(0, messages.length, ...compacted.messages)
            this.emit(runId, 'context.compacted', { removed: compacted.removedMessages, tokensBefore: compacted.tokensBefore, tokensAfter: compacted.tokensAfter })
          }
        }

        let turnText = ''
        let response: Awaited<ReturnType<AIRouter['chat']>> | undefined
        for await (const ev of router.stream(req.model ?? agent.model, { system, messages, tools: specs.length ? specs : undefined, effort: agent.effort ?? undefined, temperature: agent.temperature ?? undefined, signal }, { runId, userId: req.userId })) {
          if (ev.type === 'text_delta') {
            turnText += ev.text
            this.emit(runId, 'text.delta', { text: ev.text, turn: turns }, false)
          } else if (ev.type === 'reasoning_delta') {
            this.emit(runId, 'reasoning.delta', { text: ev.text, turn: turns }, false)
          } else if (ev.type === 'tool_use_start') {
            this.emit(runId, 'tool.preparing', { id: ev.id, name: ev.name }, false)
          } else if (ev.type === 'done') {
            response = { ...ev.response, target: ev.target! }
          }
        }
        if (!response) throw new Error('Model stream ended without a response')
        modelUsed = `${response.target.provider}:${response.model}`
        tokensIn += response.usage.inputTokens
        tokensOut += response.usage.outputTokens
        messages.push({ role: 'assistant', content: response.content })
        const text = textOf(response.content) || turnText
        if (text) this.emit(runId, 'message', { role: 'assistant', text, turn: turns })
        db.update('agent_runs', runId, { turns, tokens_in: tokensIn, tokens_out: tokensOut, model: modelUsed })

        if (response.stopReason === 'refusal') {
          finalText = text || 'The model declined this request.'
          stopNote = `Model refused${response.stopDetails ? ` (${response.stopDetails})` : ''}.`
          break
        }

        const calls = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
        if (!calls.length) {
          if (response.stopReason === 'max_tokens') {
            messages.push({ role: 'user', content: [{ type: 'text', text: 'Your previous response was cut off by the output limit. Continue exactly where you stopped.' }] })
            finalText += text
            continue
          }
          finalText = text
          break
        }

        if (response.stopReason === 'max_tokens') {
          // Tool input may be truncated: ask the model to re-issue instead of running it.
          messages.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result' as const, tool_use_id: c.id, content: 'Output limit reached while writing this tool call; its input may be incomplete. Re-issue the call (split large content into smaller edits).', is_error: true })) })
          continue
        }

        for (const c of calls) this.emit(runId, 'tool.call', { id: c.id, name: c.name, input: c.input, turn: turns })
        let loopWarning = ''
        for (const c of calls) {
          const sig = `${c.name}:${JSON.stringify(c.input)}`
          const n = (callCounts.get(sig) ?? 0) + 1
          callCounts.set(sig, n)
          if (n >= 5) throw new Error(`Loop detected: '${c.name}' was called ${n} times with identical input`)
          if (n >= 3) loopWarning = `Note: you have called ${c.name} with identical input ${n} times. The result will not change; try a different approach.`
        }
        const results = await executor.executeTurn(
          calls,
          {
            projectRoot: req.project?.rootPath,
            projectId: req.project?.id,
            userId: req.userId,
            runId,
            agentName: agent.name,
            teamRunId: req.teamRunId,
            signal,
            services: this.deps.services(),
            depth,
            emit: (type, data) => this.emit(runId, type, data),
          },
          { approvalMode: agent.approvalMode, allowed },
          (call, r) => this.emit(runId, 'tool.result', { id: call.id, name: call.name, isError: !!r.isError, content: r.content.slice(0, 8000), data: r.data }),
        )
        toolCallCount += calls.length
        db.update('agent_runs', runId, { tool_calls: toolCallCount })
        const resultContent: ContentBlock[] = [...results]
        if (loopWarning) resultContent.push({ type: 'text', text: loopWarning })
        messages.push({ role: 'user', content: resultContent })
      }

      if (turns >= maxTurns && !finalText) {
        stopNote = `Stopped after reaching the maximum of ${maxTurns} turns.`
        finalText = textOf(messages.filter((m) => m.role === 'assistant').at(-1)?.content ?? [])
      }
      const output = [finalText.trim(), stopNote].filter(Boolean).join('\n\n')
      this.persistConversation(req, runId, messages, tokensIn, tokensOut)
      this.setStatus(runId, 'completed', { output, finished_at: now(), turns, tokens_in: tokensIn, tokens_out: tokensOut, tool_calls: toolCallCount, model: modelUsed })
      this.emit(runId, 'run.completed', { output, turns, tokensIn, tokensOut, toolCalls: toolCallCount })
      metrics.runsTotal.inc({ status: 'completed' })
      return { run: this.getRun(runId), messages }
    } catch (err) {
      const cancelled = signal.aborted
      const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
      if (!cancelled) log.warn('Agent run failed', { runId, agent: req.agent.name, error: message })
      // Keep partial history so the conversation remains consistent.
      this.persistConversation(req, runId, messages, tokensIn, tokensOut)
      this.setStatus(runId, cancelled ? 'cancelled' : 'failed', { error: message, finished_at: now(), turns, tokens_in: tokensIn, tokens_out: tokensOut, tool_calls: toolCallCount, model: modelUsed })
      this.emit(runId, cancelled ? 'run.cancelled' : 'run.failed', { error: message })
      metrics.runsTotal.inc({ status: cancelled ? 'cancelled' : 'failed' })
      return { run: this.getRun(runId), messages }
    } finally {
      if (release) {
        metrics.runsActive.dec()
        release()
      }
      req.signal?.removeEventListener('abort', onParentAbort)
      this.controllers.delete(runId)
    }
  }

  /** Append the new messages of this run to the conversation. */
  private persistConversation(req: RunRequest, runId: string, messages: ChatMessage[], tokensIn: number, tokensOut: number): void {
    if (!req.conversationId) return
    const db = this.deps.db
    const fresh = messages.slice(req.history?.length ?? 0)
    if (!fresh.length) return
    // Never persist a trailing assistant tool_use without its results: drop unmatched tail.
    while (fresh.length && fresh.at(-1)!.role === 'assistant' && fresh.at(-1)!.content.some((b) => b.type === 'tool_use')) fresh.pop()
    db.transaction(() => {
      let seq = db.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM messages WHERE conversation_id = ?', [req.conversationId!])?.s ?? 0
      for (const m of fresh) {
        seq++
        db.insert('messages', { id: newId('msg'), conversation_id: req.conversationId!, seq, role: m.role, content: JSON.stringify(m.content), run_id: runId, tokens_in: null, tokens_out: null, created_at: now() })
      }
      db.run('UPDATE messages SET tokens_in = ?, tokens_out = ? WHERE id = (SELECT id FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1)', [tokensIn, tokensOut, req.conversationId!])
      db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now(), req.conversationId!])
    })
  }
}
