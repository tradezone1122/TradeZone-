/**
 * Module 22: Task Execution Engine
 *
 * Persistent task board with dependencies, priorities, assignment to agents,
 * retries, and cron schedules. A scheduler loop promotes tasks whose
 * dependencies are satisfied, executes auto-run tasks through the agent
 * runtime (respecting the global run concurrency limit), retries failures up
 * to `max_attempts`, and re-arms recurring tasks.
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { EventBus } from '../events/bus.js'
import type { AgentRunner } from '../agents/runner.js'
import type { AgentService } from '../agents/agent-service.js'
import type { PlatformMetrics } from '../monitoring/metrics.js'
import type { Logger } from '../logging/logger.js'
import { nextCronTime, parseCron } from './cron.js'
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js'

export type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'

export interface Task {
  id: string
  projectId: string | null
  teamRunId: string | null
  parentTaskId: string | null
  title: string
  description: string
  status: TaskStatus
  priority: number
  assigneeAgentId: string | null
  dependsOn: string[]
  result: string | null
  error: string | null
  runId: string | null
  attempts: number
  maxAttempts: number
  schedule: string | null
  nextRunAt: string | null
  autoRun: boolean
  createdBy: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  project_id: string | null
  team_run_id: string | null
  parent_task_id: string | null
  title: string
  description: string
  status: TaskStatus
  priority: number
  assignee_agent_id: string | null
  depends_on: string
  result: string | null
  error: string | null
  run_id: string | null
  attempts: number
  max_attempts: number
  schedule: string | null
  next_run_at: string | null
  auto_run: number
  created_by: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

const toTask = (r: Row): Task => ({
  id: r.id,
  projectId: r.project_id,
  teamRunId: r.team_run_id,
  parentTaskId: r.parent_task_id,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  assigneeAgentId: r.assignee_agent_id,
  dependsOn: parseJson(r.depends_on, []),
  result: r.result,
  error: r.error,
  runId: r.run_id,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  schedule: r.schedule,
  nextRunAt: r.next_run_at,
  autoRun: !!r.auto_run,
  createdBy: r.created_by,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export interface TaskInput {
  title: string
  description?: string
  projectId?: string | null
  parentTaskId?: string | null
  priority?: number
  assignee?: string | null
  dependsOn?: string[]
  maxAttempts?: number
  schedule?: string | null
  autoRun?: boolean
}

export type ProjectResolver = (projectId: string) => { id: string; name: string; rootPath: string; instructions?: string } | null

export class TaskService {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private inflight = new Set<string>()

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly runner: AgentRunner,
    private readonly agents: AgentService,
    private readonly metrics: PlatformMetrics,
    private readonly log: Logger,
    private readonly resolveProject: ProjectResolver,
  ) {}

  list(filter: { projectId?: string; status?: TaskStatus; teamRunId?: string | null; limit?: number } = {}): Task[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId) }
    if (filter.status) { where.push('status = ?'); params.push(filter.status) }
    if (filter.teamRunId === null) where.push('team_run_id IS NULL')
    else if (filter.teamRunId) { where.push('team_run_id = ?'); params.push(filter.teamRunId) }
    return this.db.all<Row>(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, created_at DESC LIMIT ?`, [...params, filter.limit ?? 500]).map(toTask)
  }

  get(id: string): Task {
    const r = this.db.get<Row>('SELECT * FROM tasks WHERE id = ?', [id])
    if (!r) throw new NotFoundError('Task')
    return toTask(r)
  }

  create(input: TaskInput, userId?: string): Task {
    if (!input.title?.trim()) throw new ValidationError('Task title is required')
    const deps = input.dependsOn ?? []
    for (const d of deps) this.get(d)
    if (input.schedule) parseCron(input.schedule)
    const assignee = input.assignee ? this.agents.get(input.assignee).id : null
    const ts = now()
    const id = newId('task')
    this.db.insert('tasks', {
      id,
      project_id: input.projectId ?? null,
      team_run_id: null,
      parent_task_id: input.parentTaskId ?? null,
      title: input.title.trim(),
      description: input.description ?? '',
      status: deps.length ? 'pending' : 'ready',
      priority: input.priority ?? 0,
      assignee_agent_id: assignee,
      depends_on: JSON.stringify(deps),
      attempts: 0,
      max_attempts: Math.max(1, Math.min(10, input.maxAttempts ?? 2)),
      schedule: input.schedule ?? null,
      next_run_at: input.schedule ? nextCronTime(input.schedule).toISOString() : null,
      auto_run: input.autoRun ? 1 : 0,
      created_by: userId ?? null,
      created_at: ts,
      updated_at: ts,
    })
    if (this.wouldCycle(id)) {
      this.db.run('DELETE FROM tasks WHERE id = ?', [id])
      throw new ValidationError('Task dependencies would create a cycle')
    }
    const task = this.get(id)
    this.bus.publish('tasks', 'task.created', task)
    return task
  }

  update(id: string, patch: Partial<TaskInput> & { status?: TaskStatus }): Task {
    const t = this.get(id)
    if (t.status === 'running' && patch.status && patch.status !== 'cancelled') throw new ConflictError('Task is running')
    const row: Record<string, unknown> = { updated_at: now() }
    if (patch.title !== undefined) row.title = patch.title
    if (patch.description !== undefined) row.description = patch.description
    if (patch.priority !== undefined) row.priority = patch.priority
    if (patch.assignee !== undefined) row.assignee_agent_id = patch.assignee ? this.agents.get(patch.assignee).id : null
    if (patch.dependsOn !== undefined) {
      for (const d of patch.dependsOn) this.get(d)
      row.depends_on = JSON.stringify(patch.dependsOn)
    }
    if (patch.maxAttempts !== undefined) row.max_attempts = patch.maxAttempts
    if (patch.schedule !== undefined) {
      if (patch.schedule) parseCron(patch.schedule)
      row.schedule = patch.schedule
      row.next_run_at = patch.schedule ? nextCronTime(patch.schedule).toISOString() : null
    }
    if (patch.autoRun !== undefined) row.auto_run = patch.autoRun ? 1 : 0
    if (patch.status !== undefined) {
      row.status = patch.status
      if (patch.status === 'ready' || patch.status === 'pending') {
        row.error = null
        row.attempts = 0
      }
    }
    this.db.update('tasks', t.id, row)
    if (patch.dependsOn && this.wouldCycle(t.id)) {
      this.db.update('tasks', t.id, { depends_on: JSON.stringify(t.dependsOn) })
      throw new ValidationError('Task dependencies would create a cycle')
    }
    if (patch.status === 'cancelled' && t.runId) this.runner.cancel(t.runId)
    const updated = this.get(t.id)
    this.bus.publish('tasks', 'task.updated', updated)
    return updated
  }

  delete(id: string): void {
    const t = this.get(id)
    if (t.status === 'running' && t.runId) this.runner.cancel(t.runId)
    this.db.run('DELETE FROM tasks WHERE id = ?', [t.id])
    this.bus.publish('tasks', 'task.deleted', { id: t.id })
  }

  private wouldCycle(start: string): boolean {
    const seen = new Set<string>()
    const stack = [...this.get(start).dependsOn]
    while (stack.length) {
      const id = stack.pop()!
      if (id === start) return true
      if (seen.has(id)) continue
      seen.add(id)
      const r = this.db.get<{ depends_on: string }>('SELECT depends_on FROM tasks WHERE id = ?', [id])
      if (r) stack.push(...parseJson<string[]>(r.depends_on, []))
    }
    return false
  }

  /** Execute a task now with its assignee (or the given agent). */
  async runTask(id: string, opts: { agent?: string; userId?: string } = {}): Promise<Task> {
    const t = this.get(id)
    if (t.status === 'running' || this.inflight.has(t.id)) throw new ConflictError('Task is already running')
    const unmet = t.dependsOn.filter((d) => this.get(d).status !== 'completed')
    if (unmet.length) throw new ConflictError(`Task has unfinished dependencies: ${unmet.join(', ')}`)
    const agentRef = opts.agent ?? t.assigneeAgentId ?? 'coder'
    const agent = this.agents.get(agentRef)
    const project = t.projectId ? this.resolveProject(t.projectId) : null
    this.inflight.add(t.id)
    try {
      this.db.update('tasks', t.id, { status: 'running', attempts: t.attempts + 1, started_at: now(), updated_at: now(), error: null, assignee_agent_id: agent.id })
      this.bus.publish('tasks', 'task.updated', this.get(t.id))
      const deps = t.dependsOn.map((d) => this.get(d))
      const extra = deps.length ? `## Results from prerequisite tasks\n${deps.map((d) => `### ${d.title}\n${(d.result ?? '').slice(0, 6000)}`).join('\n\n')}` : undefined
      const { runId, done } = this.runner.start({ agent, input: `${t.title}\n\n${t.description}`.trim(), userId: opts.userId ?? t.createdBy ?? undefined, project: project ?? undefined, taskId: t.id, extraContext: extra })
      this.db.update('tasks', t.id, { run_id: runId })
      const outcome = await done
      const ok = outcome.run.status === 'completed'
      const latest = this.get(t.id)
      if (latest.status === 'cancelled') return latest
      if (ok) {
        this.db.update('tasks', t.id, { status: 'completed', result: outcome.run.output, finished_at: now(), updated_at: now() })
        this.metrics.tasksTotal.inc({ status: 'completed' })
      } else {
        const retry = latest.attempts < latest.maxAttempts && outcome.run.status !== 'cancelled'
        this.db.update('tasks', t.id, { status: retry ? 'ready' : 'failed', error: outcome.run.error, finished_at: retry ? null : now(), updated_at: now() })
        if (!retry) this.metrics.tasksTotal.inc({ status: 'failed' })
      }
      if (latest.schedule) {
        this.db.update('tasks', t.id, { next_run_at: nextCronTime(latest.schedule).toISOString(), status: 'ready', attempts: 0 })
      }
      const final = this.get(t.id)
      this.bus.publish('tasks', 'task.updated', final)
      return final
    } finally {
      this.inflight.delete(t.id)
    }
  }

  /** One scheduler pass. Exposed for tests. */
  async tick(): Promise<{ promoted: number; started: number; blocked: number }> {
    if (this.ticking) return { promoted: 0, started: 0, blocked: 0 }
    this.ticking = true
    try {
      let promoted = 0
      let blocked = 0
      for (const t of this.db.all<Row>("SELECT * FROM tasks WHERE status = 'pending' AND team_run_id IS NULL").map(toTask)) {
        const deps = t.dependsOn.map((d) => this.db.get<{ status: TaskStatus }>('SELECT status FROM tasks WHERE id = ?', [d])?.status)
        if (deps.some((s) => s === 'failed' || s === 'cancelled' || s === 'blocked' || s === undefined)) {
          this.db.update('tasks', t.id, { status: 'blocked', error: 'A dependency failed or was removed', updated_at: now() })
          blocked++
        } else if (deps.every((s) => s === 'completed')) {
          this.db.update('tasks', t.id, { status: 'ready', updated_at: now() })
          promoted++
        }
      }
      const ts = now()
      const due = this.db
        .all<Row>("SELECT * FROM tasks WHERE status = 'ready' AND auto_run = 1 AND team_run_id IS NULL AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY priority DESC, created_at LIMIT 10", [ts])
        .map(toTask)
        .filter((t) => !this.inflight.has(t.id))
      for (const t of due) {
        this.runTask(t.id).catch((err) => this.log.error('Scheduled task failed to start', { taskId: t.id, error: err }))
      }
      if (promoted || blocked) this.bus.publish('tasks', 'tasks.changed', { promoted, blocked })
      return { promoted, started: due.length, blocked }
    } finally {
      this.ticking = false
    }
  }

  startScheduler(intervalMs: number): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error('Task scheduler tick failed', { error: err }))
    }, intervalMs)
    this.timer.unref()
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Mark tasks left "running" by a previous process as failed/ready on boot. */
  recoverInterrupted(): number {
    return this.db.run("UPDATE tasks SET status = CASE WHEN attempts < max_attempts THEN 'ready' ELSE 'failed' END, error = 'Interrupted by server restart', updated_at = ? WHERE status = 'running'", [now()]).changes
  }
}
