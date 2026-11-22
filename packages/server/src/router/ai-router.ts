/**
 * Module 09: AI Router
 *
 * Resolves model references to concrete provider/model pairs and executes
 * requests with fallback chains.
 *
 * Model reference forms:
 *   "anthropic:claude-opus-5-5"  explicit provider + model
 *   "route:coding"               named route (ordered fallback targets)
 *   "claude-opus-5-5"            bare model: first enabled provider listing it
 *   undefined / ""               the "default" route, or the first enabled provider's default model
 *
 * Retryable provider failures (429, 5xx, connection) fall through to the next
 * target. Every attempt is recorded in `llm_usage` and the metrics registry.
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { ChatRequest, ChatResponse, StreamEvent } from '../core/types.js'
import type { ProviderManager } from '../providers/manager.js'
import type { PlatformMetrics } from '../monitoring/metrics.js'
import type { Logger } from '../logging/logger.js'
import { NotFoundError, ProviderError, ValidationError } from '../core/errors.js'

export interface RouteTarget {
  provider: string
  model: string
}

export interface RouteConfig {
  id: string
  name: string
  description: string | null
  targets: RouteTarget[]
}

export interface ResolvedTarget extends RouteTarget {}

export interface RouterCallContext {
  runId?: string
  userId?: string
}

export class AIRouter {
  constructor(
    private readonly db: Database,
    private readonly providers: ProviderManager,
    private readonly metrics: PlatformMetrics,
    private readonly log: Logger,
    private readonly defaultModel?: string,
  ) {}

  listRoutes(): RouteConfig[] {
    return this.db
      .all<{ id: string; name: string; description: string | null; targets: string }>('SELECT * FROM routes ORDER BY name')
      .map((r) => ({ id: r.id, name: r.name, description: r.description, targets: parseJson<RouteTarget[]>(r.targets, []) }))
  }

  upsertRoute(name: string, targets: RouteTarget[], description?: string | null): RouteConfig {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) throw new ValidationError('Route name must be lowercase letters, digits, - or _')
    if (!targets.length) throw new ValidationError('A route needs at least one target')
    for (const t of targets) this.providers.get(t.provider)
    const existing = this.db.get<{ id: string }>('SELECT id FROM routes WHERE name = ?', [name])
    const ts = now()
    if (existing) this.db.update('routes', existing.id, { targets: JSON.stringify(targets), description: description ?? null, updated_at: ts })
    else this.db.insert('routes', { id: newId('route'), name, description: description ?? null, targets: JSON.stringify(targets), created_at: ts, updated_at: ts })
    return this.listRoutes().find((r) => r.name === name)!
  }

  deleteRoute(name: string): void {
    if (!this.db.run('DELETE FROM routes WHERE name = ?', [name]).changes) throw new NotFoundError(`Route '${name}'`)
  }

  /** Resolve a model reference into an ordered list of concrete targets. */
  resolve(ref?: string | null): ResolvedTarget[] {
    const enabled = this.providers.list().filter((p) => p.enabled)
    const r = (ref ?? '').trim() || this.defaultModel || ''
    if (!r || r === 'default') {
      const route = this.listRoutes().find((x) => x.name === 'default')
      if (route) return route.targets
      const first = enabled.find((p) => p.defaultModel || p.models.length)
      if (!first) throw new ValidationError('No model provider is configured. Add one under Settings → Models.')
      return [{ provider: first.id, model: first.defaultModel || first.models[0]! }]
    }
    if (r.startsWith('route:')) {
      const route = this.listRoutes().find((x) => x.name === r.slice(6))
      if (!route) throw new NotFoundError(`Route '${r.slice(6)}'`)
      return route.targets
    }
    const colon = r.indexOf(':')
    if (colon > 0) {
      const provider = r.slice(0, colon)
      const model = r.slice(colon + 1)
      const cfg = this.providers.get(provider)
      return [{ provider: cfg.id, model: model || cfg.defaultModel || cfg.models[0] || '' }]
    }
    const owner = enabled.find((p) => p.models.includes(r)) ?? enabled.find((p) => p.defaultModel === r)
    if (owner) return [{ provider: owner.id, model: r }]
    // Model not declared anywhere: guess by naming convention.
    const guess = r.startsWith('claude-') ? enabled.find((p) => p.kind === 'anthropic') : enabled.find((p) => p.kind === 'openai-compatible')
    if (guess) return [{ provider: guess.id, model: r }]
    throw new ValidationError(`No provider serves model '${r}'`)
  }

  /**
   * Stream a request through the first target that succeeds. Fallback only
   * happens before any output was streamed, so callers never see mixed output.
   */
  async *stream(ref: string | null | undefined, req: Omit<ChatRequest, 'model'>, ctx: RouterCallContext = {}): AsyncIterable<StreamEvent & { target?: ResolvedTarget }> {
    const targets = this.resolve(ref)
    let lastError: unknown
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!
      const started = Date.now()
      let emitted = false
      try {
        const provider = this.providers.client(target.provider)
        for await (const ev of provider.stream({ ...req, model: target.model })) {
          if (ev.type !== 'done') emitted = true
          if (ev.type === 'done') {
            this.record(target, ev.response, Date.now() - started, true, undefined, ctx)
            yield { ...ev, target }
          } else {
            yield ev
          }
        }
        return
      } catch (err) {
        lastError = err
        const retryable = err instanceof ProviderError ? err.retryable : false
        this.record(target, undefined, Date.now() - started, false, err instanceof Error ? err.message : String(err), ctx)
        this.log.warn('LLM request failed', { provider: target.provider, model: target.model, retryable, error: err instanceof Error ? err.message : String(err) })
        if (emitted || !retryable || i === targets.length - 1 || req.signal?.aborted) throw err
      }
    }
    throw lastError ?? new ProviderError('No route targets', false)
  }

  async chat(ref: string | null | undefined, req: Omit<ChatRequest, 'model'>, ctx: RouterCallContext = {}): Promise<ChatResponse & { target: ResolvedTarget }> {
    for await (const ev of this.stream(ref, req, ctx)) {
      if (ev.type === 'done') return { ...ev.response, target: ev.target! }
    }
    throw new ProviderError('Stream ended without a response', false)
  }

  private record(target: ResolvedTarget, res: ChatResponse | undefined, latency: number, success: boolean, error: string | undefined, ctx: RouterCallContext): void {
    const labels = { provider: target.provider, model: target.model }
    this.metrics.llmRequests.inc({ ...labels, outcome: success ? 'success' : 'error' })
    this.metrics.llmLatency.observe(latency, { provider: target.provider })
    if (res) {
      this.metrics.llmTokens.inc({ ...labels, direction: 'in' }, res.usage.inputTokens)
      this.metrics.llmTokens.inc({ ...labels, direction: 'out' }, res.usage.outputTokens)
    }
    try {
      this.db.insert('llm_usage', {
        provider_id: target.provider,
        model: target.model,
        run_id: ctx.runId ?? null,
        user_id: ctx.userId ?? null,
        tokens_in: res?.usage.inputTokens ?? 0,
        tokens_out: res?.usage.outputTokens ?? 0,
        latency_ms: latency,
        success: success ? 1 : 0,
        error: error ?? null,
        created_at: now(),
      })
    } catch (e) {
      this.log.error('Failed to record LLM usage', { error: e })
    }
  }
}
