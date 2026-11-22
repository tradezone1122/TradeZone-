/**
 * System settings (key/value, JSON) and the audit log.
 */
import type { Database } from '../db/database.js'
import { now, parseJson } from '../db/database.js'
import { ValidationError } from './errors.js'

export const DEFAULT_SETTINGS = {
  'platform.name': 'TradeZone AI Platform',
  'agents.defaultAgent': 'assistant',
  'agents.defaultApprovalMode': 'ask-writes',
  'agents.contextBudgetTokens': 150000,
  'security.allowRegistration': false,
  'security.commandDenyPatterns': [] as string[],
  'tools.webFetchEnabled': true,
  'tools.webFetchAllowlist': [] as string[],
  'memory.maxPerScope': 2000,
  'ui.theme': 'dark',
} as const

export type SettingKey = keyof typeof DEFAULT_SETTINGS

export class SettingsService {
  constructor(private readonly db: Database) {}

  all(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    for (const r of this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) out[r.key] = parseJson(r.value, null)
    return out
  }

  get<T = unknown>(key: string): T {
    const r = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
    if (r) return parseJson<T>(r.value, (DEFAULT_SETTINGS as Record<string, unknown>)[key] as T)
    return (DEFAULT_SETTINGS as Record<string, unknown>)[key] as T
  }

  set(key: string, value: unknown): void {
    if (!(key in DEFAULT_SETTINGS) && !key.startsWith('custom.')) throw new ValidationError(`Unknown setting '${key}' (custom keys must start with "custom.")`)
    const def = (DEFAULT_SETTINGS as Record<string, unknown>)[key]
    if (def !== undefined && def !== null && typeof def !== typeof value && !(Array.isArray(def) && Array.isArray(value))) {
      throw new ValidationError(`Setting '${key}' must be of type ${Array.isArray(def) ? 'array' : typeof def}`)
    }
    this.db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, JSON.stringify(value), now()])
  }

  setMany(values: Record<string, unknown>): Record<string, unknown> {
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(values)) this.set(k, v)
    })
    return this.all()
  }
}

export class AuditLog {
  constructor(private readonly db: Database) {}

  record(entry: { userId?: string | null; action: string; target?: string | null; details?: unknown; ip?: string | null }): void {
    this.db.insert('audit_logs', { user_id: entry.userId ?? null, action: entry.action, target: entry.target ?? null, details: entry.details === undefined ? null : JSON.stringify(entry.details), ip: entry.ip ?? null, created_at: now() })
  }

  list(filter: { userId?: string; action?: string; limit?: number; before?: number } = {}) {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.userId) { where.push('a.user_id = ?'); params.push(filter.userId) }
    if (filter.action) { where.push('a.action LIKE ?'); params.push(`${filter.action}%`) }
    if (filter.before) { where.push('a.id < ?'); params.push(filter.before) }
    return this.db
      .all<{ id: number; user_id: string | null; username: string | null; action: string; target: string | null; details: string | null; ip: string | null; created_at: string }>(
        `SELECT a.*, u.username FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`,
        [...params, filter.limit ?? 100],
      )
      .map((r) => ({ id: r.id, userId: r.user_id, username: r.username, action: r.action, target: r.target, details: parseJson(r.details, null), ip: r.ip, createdAt: r.created_at }))
  }
}
