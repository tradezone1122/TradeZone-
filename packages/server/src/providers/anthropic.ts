/**
 * Module 08: Model Provider — Anthropic (Claude) via the official SDK.
 *
 * Uses `client.messages.stream()` + `finalMessage()` so long generations do
 * not hit HTTP timeouts. Thinking blocks are preserved with their signatures
 * and replayed unchanged on subsequent turns, as required for multi-turn
 * tool use. Current models use adaptive thinking with `output_config.effort`;
 * sampling parameters are not sent to models that reject them.
 */
import Anthropic from '@anthropic-ai/sdk'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ModelInfo,
  ModelProvider,
  StreamEvent,
} from '../core/types.js'
import { ProviderError } from '../core/errors.js'

export interface AnthropicProviderOptions {
  id: string
  apiKey?: string
  baseUrl?: string
  /** Enable server-side refusal fallbacks on models that support them. */
  refusalFallback?: boolean
  client?: Anthropic
}

/** Models that use adaptive thinking + effort and reject sampling params / budget_tokens. */
export function isAdaptiveModel(model: string): boolean {
  return /claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[6-9])/.test(model)
}

const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/

export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const
  readonly id: string
  private readonly client: Anthropic
  private readonly refusalFallback: boolean

  constructor(opts: AnthropicProviderOptions) {
    this.id = opts.id
    this.refusalFallback = opts.refusalFallback ?? true
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl || undefined, maxRetries: 2 })
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = []
      for await (const m of this.client.models.list()) {
        const anyM = m as unknown as { id: string; display_name?: string; max_input_tokens?: number }
        out.push({ id: anyM.id, displayName: anyM.display_name, contextWindow: anyM.max_input_tokens })
      }
      return out
    } catch (err) {
      throw toProviderError(err)
    }
  }

  buildParams(req: ChatRequest): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 32000,
      messages: toAnthropicMessages(req.messages),
    }
    if (req.system) params.system = req.system
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
    }
    if (isAdaptiveModel(req.model)) {
      params.thinking = { type: 'adaptive', display: 'summarized' }
      params.output_config = { effort: req.effort ?? 'high' }
    } else if (req.temperature !== undefined) {
      params.temperature = req.temperature
    }
    return params
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const params = this.buildParams(req)
    const useFallback = this.refusalFallback && FALLBACK_MODELS.test(req.model)
    let message: Anthropic.Message
    try {
      message = yield* this.runStream(params, useFallback, req.signal)
    } catch (err) {
      // If the server-side fallback parameter is rejected, retry without it once.
      if (useFallback && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
        message = yield* this.runStream(params, false, req.signal)
      } else {
        throw toProviderError(err)
      }
    }
    yield { type: 'done', response: fromAnthropicMessage(message) }
  }

  private async *runStream(params: Record<string, unknown>, fallback: boolean, signal?: AbortSignal): AsyncGenerator<StreamEvent, Anthropic.Message> {
    const body = fallback ? { ...params, fallbacks: 'default' } : params
    const options = {
      signal,
      ...(fallback ? { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } } : {}),
    }
    const stream = this.client.messages.stream(body as unknown as Anthropic.MessageStreamParams, options)
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        yield { type: 'tool_use_start', id: event.content_block.id, name: event.content_block.name }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta as { type: string; text?: string; thinking?: string }
        if (delta.type === 'text_delta' && delta.text) yield { type: 'text_delta', text: delta.text }
        else if (delta.type === 'thinking_delta' && delta.thinking) yield { type: 'reasoning_delta', text: delta.thinking }
      }
    }
    return await stream.finalMessage()
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages
    .map((m) => ({
      role: m.role,
      content: m.content.map(toAnthropicBlock).filter((b): b is NonNullable<typeof b> => b !== null),
    }))
    .filter((m) => m.content.length > 0) as unknown as Anthropic.MessageParam[]
}

function toAnthropicBlock(b: ContentBlock): Record<string, unknown> | null {
  switch (b.type) {
    case 'text':
      return b.text ? { type: 'text', text: b.text } : null
    case 'image':
      return { type: 'image', source: b.source }
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) }
    case 'reasoning':
      // Replay thinking blocks unchanged; the API drops blocks the current model can't read.
      if (b.provenance !== 'anthropic') return null
      if (b.redactedData) return { type: 'redacted_thinking', data: b.redactedData }
      if (b.signature === undefined) return null
      return { type: 'thinking', thinking: b.text, signature: b.signature }
  }
}

export function fromAnthropicMessage(message: Anthropic.Message): ChatResponse {
  const content: ContentBlock[] = []
  for (const block of message.content as unknown as Array<Record<string, unknown>>) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: String(block.text ?? '') })
        break
      case 'thinking':
        content.push({ type: 'reasoning', text: String(block.thinking ?? ''), signature: String(block.signature ?? ''), provenance: 'anthropic', model: message.model })
        break
      case 'redacted_thinking':
        content.push({ type: 'reasoning', text: '', redactedData: String(block.data ?? ''), provenance: 'anthropic', model: message.model })
        break
      case 'tool_use':
        content.push({ type: 'tool_use', id: String(block.id), name: String(block.name), input: (block.input as Record<string, unknown>) ?? {} })
        break
      default:
        break
    }
  }
  const stopDetails = (message as unknown as { stop_details?: { category?: string; explanation?: string } | null }).stop_details
  return {
    id: message.id,
    model: message.model,
    content,
    stopReason: message.stop_reason ?? 'end_turn',
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    stopDetails: stopDetails ? [stopDetails.category, stopDetails.explanation].filter(Boolean).join(': ') : undefined,
  }
}

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof Anthropic.RateLimitError) return new ProviderError(`Anthropic rate limit: ${err.message}`, true, 429)
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError(`Anthropic authentication failed: ${err.message}`, false, 401)
  if (err instanceof Anthropic.NotFoundError) return new ProviderError(`Anthropic resource not found: ${err.message}`, false, 404)
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(`Anthropic rejected the request: ${err.message}`, false, 400)
  if (err instanceof Anthropic.InternalServerError) return new ProviderError(`Anthropic server error: ${err.message}`, true, err.status)
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Anthropic connection error: ${err.message}`, true)
  if (err instanceof Anthropic.APIError) return new ProviderError(`Anthropic API error: ${err.message}`, (err.status ?? 0) >= 500, err.status)
  if (err instanceof Error && err.name === 'AbortError') return new ProviderError('Request aborted', false)
  return new ProviderError(err instanceof Error ? err.message : String(err), false)
}
