/**
 * Module 08: Model Provider Manager
 *
 * Persists provider configurations (API keys encrypted at rest), instantiates
 * provider clients, seeds providers from environment variables on first boot,
 * tests connectivity and lists models.
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { SecretBox } from '../security/sandbox.js'
import type { ModelInfo, ModelProvider } from '../core/types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { NotFoundError, ValidationError } from '../core/errors.js'
import type { AppConfig } from '../config/index.js'
import type { Logger } from '../logging/logger.js'

export type ProviderKind = 'anthropic' | 'openai-compatible'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string | null
  hasApiKey: boolean
  models: string[]
  defaultModel: string | null
  options: Record<string, unknown>
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface ProviderRow {
  id: string
  name: string
  kind: ProviderKind
  base_url: string | null
  api_key_enc: string | null
  models: string
  default_model: string | null
  options: string
  enabled: number
  created_at: string
  updated_at: string
}

/** Well-known presets offered by the UI. Model lists are suggestions; users may edit them. */
export const PROVIDER_PRESETS: Array<{ id: string; name: string; kind: ProviderKind; baseUrl?: string; models: string[]; defaultModel: string; needsKey: boolean }> = [
  { id: 'anthropic', name: 'Anthropic (Claude)', kind: 'anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'], defaultModel: 'claude-opus-5-5', needsKey: true },
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', models: [], defaultModel: '', needsKey: true },
  { id: 'moonshot', name: 'Moonshot AI (Kimi)', kind: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1', models: [], defaultModel: '', needsKey: true },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat', needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', models: [], defaultModel: '', needsKey: true },
  { id: 'gemini', name: 'Google Gemini (OpenAI-compatible)', kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', models: [], defaultModel: '', needsKey: true },
  { id: 'ollama', name: 'Ollama (local)', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', models: [], defaultModel: '', needsKey: false },
  { id: 'lmstudio', name: 'LM Studio (local)', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', models: [], defaultModel: '', needsKey: false },
]

export class ProviderManager {
  private cache = new Map<string, ModelProvider>()
  /** Providers injected programmatically (tests, plugins). Not persisted. */
  private injected = new Map<string, { provider: ModelProvider; models: string[]; defaultModel: string }>()

  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly log: Logger,
  ) {}

  inject(provider: ModelProvider, models: string[], defaultModel: string): void {
    this.injected.set(provider.id, { provider, models, defaultModel })
  }

  list(): ProviderConfig[] {
    const rows = this.db.all<ProviderRow>('SELECT * FROM providers ORDER BY created_at').map(toConfig)
    for (const [id, inj] of this.injected) {
      rows.push({ id, name: id, kind: 'openai-compatible', baseUrl: null, hasApiKey: false, models: inj.models, defaultModel: inj.defaultModel, options: { injected: true }, enabled: true, createdAt: now(), updatedAt: now() })
    }
    return rows
  }

  get(id: string): ProviderConfig {
    const inj = this.injected.get(id)
    if (inj) return { id, name: id, kind: 'openai-compatible', baseUrl: null, hasApiKey: false, models: inj.models, defaultModel: inj.defaultModel, options: { injected: true }, enabled: true, createdAt: now(), updatedAt: now() }
    const row = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id])
    if (!row) throw new NotFoundError(`Provider '${id}'`)
    return toConfig(row)
  }

  create(input: { id?: string; name: string; kind: ProviderKind; baseUrl?: string | null; apiKey?: string | null; models?: string[]; defaultModel?: string | null; options?: Record<string, unknown>; enabled?: boolean }): ProviderConfig {
    const id = input.id ?? newId('prov')
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(id)) throw new ValidationError('Provider id must be lowercase letters, digits, - or _')
    if (this.db.get('SELECT id FROM providers WHERE id = ?', [id]) || this.injected.has(id)) throw new ValidationError(`Provider '${id}' already exists`)
    if (input.kind === 'openai-compatible' && !input.baseUrl) throw new ValidationError('OpenAI-compatible providers require a base URL')
    const ts = now()
    this.db.insert('providers', {
      id,
      name: input.name,
      kind: input.kind,
      base_url: input.baseUrl ?? null,
      api_key_enc: input.apiKey ? this.box.encrypt(input.apiKey) : null,
      models: JSON.stringify(input.models ?? []),
      default_model: input.defaultModel ?? input.models?.[0] ?? null,
      options: JSON.stringify(input.options ?? {}),
      enabled: input.enabled === false ? 0 : 1,
      created_at: ts,
      updated_at: ts,
    })
    this.log.info('Provider created', { id, kind: input.kind })
    return this.get(id)
  }

  update(id: string, patch: { name?: string; baseUrl?: string | null; apiKey?: string | null; models?: string[]; defaultModel?: string | null; options?: Record<string, unknown>; enabled?: boolean }): ProviderConfig {
    this.get(id)
    const row: Record<string, unknown> = { updated_at: now() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.baseUrl !== undefined) row.base_url = patch.baseUrl
    if (patch.apiKey !== undefined) row.api_key_enc = patch.apiKey ? this.box.encrypt(patch.apiKey) : null
    if (patch.models !== undefined) row.models = JSON.stringify(patch.models)
    if (patch.defaultModel !== undefined) row.default_model = patch.defaultModel
    if (patch.options !== undefined) row.options = JSON.stringify(patch.options)
    if (patch.enabled !== undefined) row.enabled = patch.enabled ? 1 : 0
    this.db.update('providers', id, row)
    this.cache.delete(id)
    return this.get(id)
  }

  delete(id: string): void {
    const res = this.db.run('DELETE FROM providers WHERE id = ?', [id])
    if (!res.changes) throw new NotFoundError(`Provider '${id}'`)
    this.cache.delete(id)
  }

  /** Instantiate (and cache) the provider client. */
  client(id: string): ModelProvider {
    const inj = this.injected.get(id)
    if (inj) return inj.provider
    const cached = this.cache.get(id)
    if (cached) return cached
    const row = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id])
    if (!row) throw new NotFoundError(`Provider '${id}'`)
    if (!row.enabled) throw new ValidationError(`Provider '${id}' is disabled`)
    const apiKey = row.api_key_enc ? this.box.decrypt(row.api_key_enc) : undefined
    const options = parseJson<Record<string, unknown>>(row.options, {})
    const provider: ModelProvider =
      row.kind === 'anthropic'
        ? new AnthropicProvider({ id, apiKey, baseUrl: row.base_url ?? undefined, refusalFallback: options.refusalFallback !== false })
        : new OpenAICompatibleProvider({ id, apiKey, baseUrl: row.base_url ?? undefined, useMaxCompletionTokens: options.useMaxCompletionTokens === true })
    this.cache.set(id, provider)
    return provider
  }

  async test(id: string): Promise<{ ok: boolean; models: ModelInfo[]; error?: string; latencyMs: number }> {
    const started = Date.now()
    try {
      const models = await this.client(id).listModels(AbortSignal.timeout(15_000))
      return { ok: true, models, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started }
    }
  }

  /** Seed providers from environment on first boot (does not overwrite existing rows). */
  seedFromEnv(seeds: AppConfig['providerSeeds']): string[] {
    const created: string[] = []
    const add = (presetId: string, apiKey?: string, baseUrl?: string) => {
      if (this.db.get('SELECT id FROM providers WHERE id = ?', [presetId])) return
      const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)!
      this.create({ id: preset.id, name: preset.name, kind: preset.kind, baseUrl: baseUrl ?? preset.baseUrl ?? null, apiKey: apiKey ?? null, models: preset.models, defaultModel: preset.defaultModel || null })
      created.push(presetId)
    }
    if (seeds.anthropicApiKey) add('anthropic', seeds.anthropicApiKey, seeds.anthropicBaseUrl)
    if (seeds.openaiApiKey) add('openai', seeds.openaiApiKey, seeds.openaiBaseUrl)
    if (seeds.moonshotApiKey) add('moonshot', seeds.moonshotApiKey)
    if (seeds.deepseekApiKey) add('deepseek', seeds.deepseekApiKey)
    if (seeds.openrouterApiKey) add('openrouter', seeds.openrouterApiKey)
    if (seeds.geminiApiKey) add('gemini', seeds.geminiApiKey)
    if (seeds.ollamaBaseUrl) add('ollama', undefined, seeds.ollamaBaseUrl)
    return created
  }
}

function toConfig(r: ProviderRow): ProviderConfig {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    baseUrl: r.base_url,
    hasApiKey: !!r.api_key_enc,
    models: parseJson<string[]>(r.models, []),
    defaultModel: r.default_model,
    options: parseJson<Record<string, unknown>>(r.options, {}),
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
