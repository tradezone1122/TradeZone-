/**
 * Module 21: Autonomous Planning Engine
 *
 * Turns a goal into a validated task DAG. The model proposes a plan as JSON;
 * the planner validates it (unique ids, known assignees, no missing or cyclic
 * dependencies), repairs what it can, asks the model to fix what it cannot,
 * and computes execution waves. Also supports replanning after failures.
 */
import type { AIRouter } from '../router/ai-router.js'
import { textOf } from '../core/types.js'
import { extractJson } from './json.js'
import { COORDINATOR_PROMPT } from '../prompts/roles.js'
import { ValidationError } from '../core/errors.js'

export interface PlanTask {
  id: string
  title: string
  description: string
  assignee: string
  dependsOn: string[]
}

export interface Plan {
  summary: string
  tasks: PlanTask[]
}

export interface RosterEntry {
  name: string
  role: string
  description: string | null
  capabilities: string[]
}

/** Validate and normalize a plan. Returns problems that could not be auto-repaired. */
export function validatePlan(raw: unknown, roster: RosterEntry[]): { plan: Plan; problems: string[] } {
  const problems: string[] = []
  const obj = (raw ?? {}) as { summary?: unknown; tasks?: unknown }
  const list = Array.isArray(obj.tasks) ? obj.tasks : Array.isArray(raw) ? (raw as unknown[]) : []
  if (!list.length) return { plan: { summary: String(obj.summary ?? ''), tasks: [] }, problems: ['Plan has no tasks'] }
  const names = new Set(roster.map((r) => r.name))
  const tasks: PlanTask[] = []
  const ids = new Set<string>()
  list.slice(0, 20).forEach((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>
    let id = String(o.id ?? `t${i + 1}`).trim() || `t${i + 1}`
    while (ids.has(id)) id = `${id}_${i}`
    ids.add(id)
    const title = String(o.title ?? o.name ?? `Task ${i + 1}`).trim()
    const description = String(o.description ?? o.details ?? title).trim()
    let assignee = String(o.assignee ?? o.agent ?? '').trim()
    if (!names.has(assignee)) {
      const guess = bestAgentFor(`${title} ${description}`, roster)
      if (assignee) problems.push(`Task ${id}: unknown assignee '${assignee}', reassigned to '${guess}'`)
      assignee = guess
    }
    const deps = Array.isArray(o.dependsOn) ? o.dependsOn : Array.isArray(o.depends_on) ? o.depends_on : Array.isArray(o.dependencies) ? o.dependencies : []
    tasks.push({ id, title, description, assignee, dependsOn: deps.map(String) })
  })
  for (const t of tasks) {
    const before = t.dependsOn.length
    t.dependsOn = [...new Set(t.dependsOn.filter((d) => ids.has(d) && d !== t.id))]
    if (t.dependsOn.length !== before) problems.push(`Task ${t.id}: removed unknown or self dependencies`)
  }
  const cycle = findCycle(tasks)
  if (cycle) problems.push(`Dependency cycle: ${cycle.join(' -> ')}`)
  return { plan: { summary: String(obj.summary ?? ''), tasks }, problems: problems.filter((p) => p.startsWith('Dependency cycle') || p === 'Plan has no tasks') }
}

export function findCycle(tasks: PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    state.set(id, 1)
    stack.push(id)
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d]
      if (!state.get(d)) {
        const c = visit(d)
        if (c) return c
      }
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const t of tasks) if (!state.get(t.id)) {
    const c = visit(t.id)
    if (c) return c
  }
  return null
}

/** Group tasks into waves of mutually independent tasks (topological levels). */
export function executionWaves(tasks: PlanTask[]): string[][] {
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]))
  const waves: string[][] = []
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id)
    if (!ready.length) throw new ValidationError('Plan contains a dependency cycle')
    waves.push(ready)
    for (const id of ready) remaining.delete(id)
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id)
  }
  return waves
}

export function bestAgentFor(text: string, roster: RosterEntry[]): string {
  const lower = text.toLowerCase()
  let best = roster[0]?.name ?? 'coder'
  let bestScore = -1
  for (const r of roster) {
    let score = 0
    for (const c of r.capabilities) if (lower.includes(c.toLowerCase())) score += 2
    if (lower.includes(r.role)) score += 3
    for (const w of (r.description ?? '').toLowerCase().split(/\W+/)) if (w.length > 4 && lower.includes(w)) score += 0.5
    if (score > bestScore) {
      best = r.name
      bestScore = score
    }
  }
  return best
}

export class Planner {
  constructor(private readonly router: AIRouter) {}

  async plan(goal: string, roster: RosterEntry[], opts: { model?: string | null; context?: string; signal?: AbortSignal; runId?: string; userId?: string } = {}): Promise<Plan> {
    const rosterText = roster.map((r) => `- ${r.name} (${r.role}): ${r.description ?? ''} [capabilities: ${r.capabilities.join(', ')}]`).join('\n')
    const userMsg = `Goal:\n${goal}\n\nTeam roster:\n${rosterText}${opts.context ? `\n\nRepository context:\n${opts.context.slice(0, 20_000)}` : ''}`
    const messages: import('../core/types.js').ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: userMsg }] }]
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.router.chat(opts.model, { system: COORDINATOR_PROMPT, messages, maxTokens: 8000, json: true, effort: 'high', signal: opts.signal }, { runId: opts.runId, userId: opts.userId })
      const text = textOf(res.content)
      const raw = extractJson(text)
      const { plan, problems } = validatePlan(raw, roster)
      if (!problems.length && plan.tasks.length) return plan
      messages.push({ role: 'assistant', content: [{ type: 'text', text: text || '(empty)' }] })
      messages.push({ role: 'user', content: [{ type: 'text', text: `That plan is invalid: ${problems.join('; ') || 'no valid JSON found'}. Reply with corrected JSON only.` }] })
    }
    throw new ValidationError('The model failed to produce a valid plan after 3 attempts')
  }

  async replan(goal: string, roster: RosterEntry[], previous: Plan, results: Record<string, { status: string; output: string }>, opts: { model?: string | null; signal?: AbortSignal; userId?: string } = {}): Promise<Plan> {
    const summary = previous.tasks.map((t) => `- ${t.id} ${t.title} [${results[t.id]?.status ?? 'not run'}]: ${(results[t.id]?.output ?? '').slice(0, 600)}`).join('\n')
    return this.plan(`${goal}\n\nA previous plan was partially executed:\n${summary}\n\nPlan ONLY the remaining work needed to finish the goal, fixing what failed.`, roster, opts)
  }
}
