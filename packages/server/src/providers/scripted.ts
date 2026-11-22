/**
 * Deterministic scripted provider used by the automated test-suite to drive
 * the agent runtime, orchestrator and tool loop end-to-end without network
 * access. It is NOT registered in production: the provider manager only
 * accepts it when explicitly injected by code (tests).
 *
 * Each queued step is either a fixed response or a function of the request,
 * so tests can assert on what the runtime actually sent.
 */
import type { ChatRequest, ChatResponse, ContentBlock, ModelInfo, ModelProvider, StreamEvent } from '../core/types.js'

export type ScriptStep = ContentBlock[] | ((req: ChatRequest) => ContentBlock[])

export class ScriptedProvider implements ModelProvider {
  readonly kind = 'scripted' as const
  readonly requests: ChatRequest[] = []
  private steps: ScriptStep[] = []
  private fallback?: (req: ChatRequest) => ContentBlock[]

  constructor(readonly id = 'scripted') {}

  enqueue(...steps: ScriptStep[]): this {
    this.steps.push(...steps)
    return this
  }

  /** Response generator used when the queue is empty. */
  otherwise(fn: (req: ChatRequest) => ContentBlock[]): this {
    this.fallback = fn
    return this
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'scripted-model', displayName: 'Scripted (tests)' }]
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(structuredClone({ ...req, signal: undefined }))
    if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const step = this.steps.shift()
    let content: ContentBlock[]
    if (step) content = typeof step === 'function' ? step(req) : step
    else if (this.fallback) content = this.fallback(req)
    else throw new Error('ScriptedProvider: no scripted response left')
    for (const b of content) {
      if (b.type === 'text') yield { type: 'text_delta', text: b.text }
      if (b.type === 'tool_use') yield { type: 'tool_use_start', id: b.id, name: b.name }
    }
    const response: ChatResponse = {
      id: `scripted_${this.requests.length}`,
      model: req.model,
      content,
      stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: { inputTokens: Math.ceil(JSON.stringify(req.messages).length / 4), outputTokens: Math.ceil(JSON.stringify(content).length / 4) },
    }
    yield { type: 'done', response }
  }
}
