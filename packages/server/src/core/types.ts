/**
 * Module 01: Core AI Engine — provider-neutral message model.
 *
 * The block shapes intentionally mirror the content-block model used by the
 * vendored open-multi-agent runtime (MIT), so conversations can be passed to
 * either engine without conversion.
 */

export interface TextBlock {
  type: 'text'
  text: string
}

/** Provider-native reasoning. Replayed unchanged to the provider that issued it. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  signature?: string
  /** Provider kind that produced this block (e.g. 'anthropic'). */
  provenance?: string
  /** Model that produced this block. */
  model?: string
  /** Opaque redacted payload (Anthropic `redacted_thinking`). */
  redactedData?: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolUseBlock | ToolResultBlock | ImageBlock

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ChatRequest {
  model: string
  system?: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  effort?: Effort
  signal?: AbortSignal
  /** Request JSON-only output (best-effort across providers). */
  json?: boolean
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'stop_sequence' | 'pause_turn' | 'error' | string

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface ChatResponse {
  id: string
  model: string
  content: ContentBlock[]
  stopReason: StopReason
  usage: Usage
  /** Provider-specific detail, e.g. refusal category. */
  stopDetails?: string
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'done'; response: ChatResponse }

export interface ModelInfo {
  id: string
  displayName?: string
  contextWindow?: number
}

export interface ModelProvider {
  readonly id: string
  readonly kind: 'anthropic' | 'openai-compatible' | 'scripted'
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  stream(req: ChatRequest): AsyncIterable<StreamEvent>
}

/** Collect a stream into its final response. */
export async function collect(stream: AsyncIterable<StreamEvent>, onEvent?: (e: StreamEvent) => void): Promise<ChatResponse> {
  let final: ChatResponse | undefined
  for await (const ev of stream) {
    onEvent?.(ev)
    if (ev.type === 'done') final = ev.response
  }
  if (!final) throw new Error('Provider stream ended without a final response')
  return final
}

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export function userText(text: string): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** Rough token estimate (≈4 chars/token) used for context budgeting. */
export function estimateTokens(value: string | ChatMessage[] | ContentBlock[]): number {
  if (typeof value === 'string') return Math.ceil(value.length / 4)
  let chars = 0
  for (const item of value as Array<ChatMessage | ContentBlock>) {
    if ('role' in item) chars += JSON.stringify(item.content).length
    else chars += JSON.stringify(item).length
  }
  return Math.ceil(chars / 4)
}
