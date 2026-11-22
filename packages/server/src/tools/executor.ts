/**
 * Module 11: Tool Execution Engine
 *
 * Validates input, enforces the agent's approval policy, applies timeouts and
 * output truncation, records an audit trail and emits metrics. Read-only tool
 * calls from one model turn run in parallel; mutating calls run sequentially
 * in the order the model issued them.
 */
import type { Database } from '../db/database.js'
import { newId, now } from '../db/database.js'
import type { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from './registry.js'
import { validateAgainstJsonSchema } from './registry.js'
import type { ApprovalService } from './approvals.js'
import type { PlatformMetrics } from '../monitoring/metrics.js'
import type { Logger } from '../logging/logger.js'
import type { ToolResultBlock, ToolUseBlock } from '../core/types.js'
import { redactSecrets } from '../security/secrets.js'

export type ApprovalMode = 'auto' | 'ask-writes' | 'ask-all' | 'readonly'

export interface ExecuteOptions {
  approvalMode: ApprovalMode
  /** Tools the caller is allowed to use (already filtered). */
  allowed: Set<string>
  timeoutMs?: number
  maxOutputChars?: number
}

export const DEFAULT_MAX_OUTPUT = 30_000

export function truncateOutput(text: string, max = DEFAULT_MAX_OUTPUT): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head)}\n\n… [${text.length - max} characters truncated] …\n\n${text.slice(-tail)}`
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly approvals: ApprovalService,
    private readonly db: Database,
    private readonly metrics: PlatformMetrics,
    private readonly log: Logger,
  ) {}

  needsApproval(tool: ToolDefinition<any>, mode: ApprovalMode): boolean {
    if (mode === 'auto') return false
    if (mode === 'ask-all') return tool.permission !== 'read'
    if (mode === 'ask-writes') return tool.permission === 'write' || tool.permission === 'execute'
    return false
  }

  async execute(call: ToolUseBlock, ctx: ToolContext, opts: ExecuteOptions): Promise<ToolResult> {
    const started = Date.now()
    const tool = this.registry.get(call.name)
    let result: ToolResult
    if (!tool) result = { content: `Unknown tool '${call.name}'.`, isError: true }
    else if (!opts.allowed.has(tool.name)) result = { content: `Tool '${call.name}' is not available to this agent.`, isError: true }
    else if (opts.approvalMode === 'readonly' && tool.permission !== 'read') result = { content: `Tool '${call.name}' is blocked: this agent is read-only.`, isError: true }
    else if (tool.requiresProject && !ctx.projectRoot) result = { content: `Tool '${call.name}' requires an active project.`, isError: true }
    else result = await this.runValidated(tool, call, ctx, opts)

    const duration = Date.now() - started
    result = { ...result, content: truncateOutput(result.content, opts.maxOutputChars) }
    this.metrics.toolCalls.inc({ tool: call.name, outcome: result.isError ? 'error' : 'success' })
    this.metrics.toolDuration.observe(duration, { tool: call.name })
    try {
      this.db.insert('tool_calls', {
        id: newId('tc'),
        run_id: ctx.runId ?? null,
        user_id: ctx.userId ?? null,
        project_id: ctx.projectId ?? null,
        tool: call.name,
        input: redactSecrets(JSON.stringify(call.input)).slice(0, 20_000),
        output: redactSecrets(result.content).slice(0, 20_000),
        is_error: result.isError ? 1 : 0,
        duration_ms: duration,
        created_at: now(),
      })
    } catch (err) {
      this.log.error('Failed to record tool call', { error: err })
    }
    return result
  }

  private async runValidated(tool: ToolDefinition<any>, call: ToolUseBlock, ctx: ToolContext, opts: ExecuteOptions): Promise<ToolResult> {
    let input: unknown = call.input
    if ('__invalid_json' in (call.input ?? {})) {
      return { content: 'Tool input was not valid JSON. Re-issue the call with a valid JSON object.', isError: true }
    }
    if (tool.schema) {
      const parsed = tool.schema.safeParse(call.input ?? {})
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        return { content: `Invalid input for '${tool.name}': ${issues}`, isError: true }
      }
      input = parsed.data
    } else if (tool.jsonSchema) {
      const errors = validateAgainstJsonSchema(tool.jsonSchema, (call.input ?? {}) as Record<string, unknown>)
      if (errors.length) return { content: `Invalid input for '${tool.name}': ${errors.join('; ')}`, isError: true }
    }

    if (this.needsApproval(tool, opts.approvalMode)) {
      ctx.emit?.('tool.approval_wait', { id: call.id, name: call.name })
      const approved = await this.approvals.request(
        { runId: ctx.runId, userId: ctx.userId, tool: tool.name, input: call.input, reason: `Agent ${ctx.agentName ?? ''} wants to run ${tool.name} (${tool.permission})` },
        10 * 60_000,
        ctx.signal,
      )
      if (!approved) return { content: `The user denied (or did not approve in time) the call to '${tool.name}'. Choose another approach or ask the user.`, isError: true }
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timeout = opts.timeoutMs ?? 5 * 60_000
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      return await Promise.race([
        tool.handler(input, { ...ctx, signal: controller.signal }),
        new Promise<ToolResult>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(ctx.signal.aborted ? 'Cancelled' : `Timed out after ${timeout} ms`)), { once: true })),
      ])
    } catch (err) {
      return { content: `Tool '${tool.name}' failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Execute all tool calls of one assistant turn. Consecutive read-only calls
   * are batched in parallel; others run sequentially. Results keep call order.
   */
  async executeTurn(calls: ToolUseBlock[], ctx: ToolContext, opts: ExecuteOptions, onResult?: (call: ToolUseBlock, r: ToolResult) => void): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = new Array(calls.length)
    let i = 0
    while (i < calls.length) {
      const batch: number[] = []
      while (i < calls.length && this.registry.get(calls[i]!.name)?.permission === 'read') batch.push(i++)
      if (batch.length) {
        await Promise.all(
          batch.map(async (idx) => {
            const r = await this.execute(calls[idx]!, ctx, opts)
            onResult?.(calls[idx]!, r)
            results[idx] = { type: 'tool_result', tool_use_id: calls[idx]!.id, content: r.content || '(no output)', is_error: r.isError || undefined }
          }),
        )
        continue
      }
      const idx = i++
      const r = await this.execute(calls[idx]!, ctx, opts)
      onResult?.(calls[idx]!, r)
      results[idx] = { type: 'tool_result', tool_use_id: calls[idx]!.id, content: r.content || '(no output)', is_error: r.isError || undefined }
    }
    return results
  }
}
