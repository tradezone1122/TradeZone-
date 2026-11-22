/**
 * Module 08: Model Provider — OpenAI-compatible Chat Completions.
 *
 * One implementation covers OpenAI, Moonshot (Kimi), DeepSeek, OpenRouter,
 * Google Gemini (OpenAI-compatible endpoint), Groq, Together, Ollama,
 * LM Studio and vLLM — anything that speaks `/v1/chat/completions`.
 */
import OpenAI from 'openai'
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

export interface OpenAICompatibleOptions {
  id: string
  apiKey?: string
  baseUrl?: string
  /** Use `max_completion_tokens` instead of `max_tokens` (newer OpenAI models). */
  useMaxCompletionTokens?: boolean
  client?: OpenAI
}

type OAMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind = 'openai-compatible' as const
  readonly id: string
  private readonly client: OpenAI
  private readonly useMaxCompletionTokens: boolean

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id
    this.useMaxCompletionTokens = opts.useMaxCompletionTokens ?? false
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey || 'not-required', baseURL: opts.baseUrl || undefined, maxRetries: 2 })
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = []
      for await (const m of this.client.models.list()) out.push({ id: m.id })
      return out
    } catch (err) {
      throw toProviderError(err)
    }
  }

  buildParams(req: ChatRequest): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
    const messages: OAMessage[] = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    messages.push(...toOpenAIMessages(req.messages))
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    const max = req.maxTokens ?? 8192
    if (this.useMaxCompletionTokens) params.max_completion_tokens = max
    else params.max_tokens = max
    if (req.temperature !== undefined) params.temperature = req.temperature
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }))
    }
    if (req.json) params.response_format = { type: 'json_object' }
    return params
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const params = this.buildParams(req)
    let text = ''
    let reasoning = ''
    let finish: string | null = null
    let id = ''
    let model = req.model
    let usage = { inputTokens: 0, outputTokens: 0 }
    const calls = new Map<number, { id: string; name: string; args: string }>()
    try {
      const stream = await this.client.chat.completions.create(params, { signal: req.signal })
      for await (const chunk of stream) {
        id = chunk.id || id
        model = chunk.model || model
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string; reasoning?: string }
          if (delta?.content) {
            text += delta.content
            yield { type: 'text_delta', text: delta.content }
          }
          const r = delta?.reasoning_content ?? delta?.reasoning
          if (r) {
            reasoning += r
            yield { type: 'reasoning_delta', text: r }
          }
          for (const tc of delta?.tool_calls ?? []) {
            let entry = calls.get(tc.index)
            if (!entry) {
              entry = { id: tc.id ?? `call_${tc.index}_${Date.now()}`, name: tc.function?.name ?? '', args: '' }
              calls.set(tc.index, entry)
              if (entry.name) yield { type: 'tool_use_start', id: entry.id, name: entry.name }
            } else if (tc.function?.name && !entry.name) {
              entry.name = tc.function.name
            }
            if (tc.id) entry.id = tc.id
            if (tc.function?.arguments) entry.args += tc.function.arguments
          }
          if (choice.finish_reason) finish = choice.finish_reason
        }
      }
    } catch (err) {
      throw toProviderError(err)
    }
    const content: ContentBlock[] = []
    if (reasoning) content.push({ type: 'reasoning', text: reasoning, provenance: 'openai-compatible', model })
    if (text) content.push({ type: 'text', text })
    for (const call of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)) {
      let input: Record<string, unknown> = {}
      try {
        input = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {}
      } catch {
        input = { __invalid_json: call.args }
      }
      content.push({ type: 'tool_use', id: call.id, name: call.name, input })
    }
    const stopReason =
      finish === 'tool_calls' || calls.size > 0 ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn'
    const response: ChatResponse = { id: id || `oa_${Date.now()}`, model, content, stopReason, usage }
    yield { type: 'done', response }
  }
}

export function toOpenAIMessages(messages: ChatMessage[]): OAMessage[] {
  const out: OAMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
      const toolCalls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const tu = b as { id: string; name: string; input: Record<string, unknown> }
          return { id: tu.id, type: 'function' as const, function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) } }
        })
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = { role: 'assistant', content: text || null }
      if (toolCalls.length) msg.tool_calls = toolCalls
      if (text || toolCalls.length) out.push(msg)
    } else {
      const results = m.content.filter((b) => b.type === 'tool_result') as Array<{ tool_use_id: string; content: string; is_error?: boolean }>
      for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.is_error ? `ERROR: ${r.content}` : r.content })
      const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text })
        if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } })
      }
      if (parts.length === 1 && parts[0]!.type === 'text') out.push({ role: 'user', content: (parts[0] as { text: string }).text })
      else if (parts.length) out.push({ role: 'user', content: parts })
    }
  }
  return out
}

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof OpenAI.RateLimitError) return new ProviderError(`Rate limited: ${err.message}`, true, 429)
  if (err instanceof OpenAI.AuthenticationError) return new ProviderError(`Authentication failed: ${err.message}`, false, 401)
  if (err instanceof OpenAI.NotFoundError) return new ProviderError(`Not found: ${err.message}`, false, 404)
  if (err instanceof OpenAI.BadRequestError) return new ProviderError(`Request rejected: ${err.message}`, false, 400)
  if (err instanceof OpenAI.InternalServerError) return new ProviderError(`Provider server error: ${err.message}`, true, err.status)
  if (err instanceof OpenAI.APIConnectionError) return new ProviderError(`Connection error: ${err.message}`, true)
  if (err instanceof OpenAI.APIError) return new ProviderError(`Provider API error: ${err.message}`, (err.status ?? 0) >= 500, err.status)
  if (err instanceof Error && err.name === 'AbortError') return new ProviderError('Request aborted', false)
  return new ProviderError(err instanceof Error ? err.message : String(err), false)
}
