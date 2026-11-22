/**
 * Module 32: Database Layer
 *
 * Thin, typed wrapper around Node's built-in `node:sqlite` (SQLite 3.4x with
 * FTS5). Provides versioned migrations, transactions, JSON helpers and ID
 * generation. All repositories in the platform use this class.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { MIGRATIONS } from './migrations.js'

export type Row = Record<string, unknown>
export type Params = SQLInputValue[] | Record<string, SQLInputValue>

export class Database {
  readonly raw: DatabaseSync
  private txDepth = 0

  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.raw = new DatabaseSync(file)
    this.raw.exec('PRAGMA foreign_keys = ON;')
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;')
    this.raw.exec('PRAGMA busy_timeout = 5000;')
  }

  migrate(): number {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version))
    let count = 0
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue
      this.transaction(() => {
        this.raw.exec(m.sql)
        this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, now()])
      })
      count++
    }
    return count
  }

  private bind(params?: Params): SQLInputValue[] | [Record<string, SQLInputValue>] {
    if (!params) return []
    if (Array.isArray(params)) return params.map(normalize)
    const obj: Record<string, SQLInputValue> = {}
    for (const [k, v] of Object.entries(params)) obj[k] = normalize(v)
    return [obj]
  }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number | bigint } {
    const res = this.raw.prepare(sql).run(...(this.bind(params) as SQLInputValue[]))
    return { changes: Number(res.changes), lastInsertRowid: res.lastInsertRowid }
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    return this.raw.prepare(sql).get(...(this.bind(params) as SQLInputValue[])) as T | undefined
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    return this.raw.prepare(sql).all(...(this.bind(params) as SQLInputValue[])) as T[]
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const sp = `sp_${this.txDepth}`
      this.raw.exec(`SAVEPOINT ${sp}`)
      this.txDepth++
      try {
        const out = fn()
        this.raw.exec(`RELEASE ${sp}`)
        return out
      } catch (e) {
        this.raw.exec(`ROLLBACK TO ${sp}`)
        throw e
      } finally {
        this.txDepth--
      }
    }
    this.raw.exec('BEGIN')
    this.txDepth++
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    } finally {
      this.txDepth--
    }
  }

  /** Insert a row from an object; returns the object. */
  insert<T extends Row>(table: string, row: T): T {
    const keys = Object.keys(row)
    const sql = `INSERT INTO ${ident(table)} (${keys.map(ident).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    this.run(sql, keys.map((k) => row[k] as SQLInputValue))
    return row
  }

  /** Update columns of a row identified by `id`. */
  update(table: string, id: string, patch: Row): number {
    const keys = Object.keys(patch)
    if (!keys.length) return 0
    const sql = `UPDATE ${ident(table)} SET ${keys.map((k) => `${ident(k)} = ?`).join(', ')} WHERE id = ?`
    return this.run(sql, [...keys.map((k) => patch[k] as SQLInputValue), id]).changes
  }

  sizeBytes(): number {
    const pages = this.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0
    const size = this.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0
    return pages * size
  }

  close(): void {
    this.raw.close()
  }
}

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`)
  return name
}

function normalize(v: unknown): SQLInputValue {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.toISOString()
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v)
  return v as SQLInputValue
}

export function now(): string {
  return new Date().toISOString()
}

export function newId(prefix = ''): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 20)
  return prefix ? `${prefix}_${id}` : id
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
