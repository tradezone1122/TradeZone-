/**
 * Module 05: Agent Memory
 *
 * Long-term memory scoped to global / user / project / agent. Retrieval uses
 * SQLite FTS5 (BM25) blended with recency, importance and access frequency.
 * Agents read and write memory through the `memory_save` / `memory_search`
 * tools; the context manager injects the most relevant memories into prompts.
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import { NotFoundError, ValidationError } from '../core/errors.js'

export type MemoryScope = 'global' | 'user' | 'project' | 'agent'

export interface Memory {
  id: string
  scope: MemoryScope
  scopeId: string | null
  kind: string
  content: string
  tags: string[]
  importance: number
  source: string | null
  accessCount: number
  lastAccessedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

interface Row {
  rowid?: number
  id: string
  scope: MemoryScope
  scope_id: string | null
  kind: string
  content: string
  tags: string
  importance: number
  source: string | null
  access_count: number
  last_accessed_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  rank?: number
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  scope: r.scope,
  scopeId: r.scope_id,
  kind: r.kind,
  content: r.content,
  tags: parseJson<string[]>(r.tags, []),
  importance: r.importance,
  source: r.source,
  accessCount: r.access_count,
  lastAccessedAt: r.last_accessed_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export interface ScopeFilter {
  scope: MemoryScope
  scopeId?: string | null
}

/** Build an FTS5 query from free text: tokens OR-ed, prefix-matched, quoted. */
export function ftsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .slice(0, 24)
  if (!tokens.length) return null
  return [...new Set(tokens)].map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ')
}

export class MemoryService {
  constructor(private readonly db: Database) {}

  add(input: { scope: MemoryScope; scopeId?: string | null; content: string; kind?: string; tags?: string[]; importance?: number; source?: string; createdBy?: string }): Memory {
    const content = input.content.trim()
    if (!content) throw new ValidationError('Memory content is empty')
    if (content.length > 20_000) throw new ValidationError('Memory content exceeds 20,000 characters')
    if (input.scope !== 'global' && !input.scopeId) throw new ValidationError(`Scope '${input.scope}' requires a scopeId`)
    // De-duplicate exact repeats within a scope.
    const dup = this.db.get<Row>('SELECT * FROM memories WHERE scope = ? AND IFNULL(scope_id, \'\') = IFNULL(?, \'\') AND content = ?', [input.scope, input.scopeId ?? null, content])
    if (dup) {
      this.db.run('UPDATE memories SET importance = MAX(importance, ?), updated_at = ? WHERE id = ?', [input.importance ?? 0.5, now(), dup.id])
      return this.get(dup.id)
    }
    const ts = now()
    const id = newId('mem')
    this.db.insert('memories', {
      id,
      scope: input.scope,
      scope_id: input.scope === 'global' ? null : input.scopeId,
      kind: input.kind ?? 'fact',
      content,
      tags: JSON.stringify(input.tags ?? []),
      importance: clamp(input.importance ?? 0.5),
      source: input.source ?? null,
      access_count: 0,
      created_by: input.createdBy ?? null,
      created_at: ts,
      updated_at: ts,
    })
    return this.get(id)
  }

  get(id: string): Memory {
    const r = this.db.get<Row>('SELECT * FROM memories WHERE id = ?', [id])
    if (!r) throw new NotFoundError('Memory')
    return toMemory(r)
  }

  update(id: string, patch: { content?: string; tags?: string[]; importance?: number; kind?: string }): Memory {
    this.get(id)
    const row: Record<string, unknown> = { updated_at: now() }
    if (patch.content !== undefined) row.content = patch.content.trim()
    if (patch.tags !== undefined) row.tags = JSON.stringify(patch.tags)
    if (patch.importance !== undefined) row.importance = clamp(patch.importance)
    if (patch.kind !== undefined) row.kind = patch.kind
    this.db.update('memories', id, row)
    return this.get(id)
  }

  delete(id: string): void {
    if (!this.db.run('DELETE FROM memories WHERE id = ?', [id]).changes) throw new NotFoundError('Memory')
  }

  list(filter: { scope?: MemoryScope; scopeId?: string | null; kind?: string; limit?: number; offset?: number } = {}): { items: Memory[]; total: number } {
    const where: string[] = []
    const params: Array<string | number | null> = []
    if (filter.scope) {
      where.push('scope = ?')
      params.push(filter.scope)
    }
    if (filter.scopeId !== undefined) {
      where.push("IFNULL(scope_id, '') = IFNULL(?, '')")
      params.push(filter.scopeId)
    }
    if (filter.kind) {
      where.push('kind = ?')
      params.push(filter.kind)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memories ${clause}`, params)?.n ?? 0
    const items = this.db.all<Row>(`SELECT * FROM memories ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, filter.limit ?? 50, filter.offset ?? 0]).map(toMemory)
    return { items, total }
  }

  /**
   * Hybrid retrieval across several scopes. Score = BM25 relevance (normalized)
   * × 0.6 + importance × 0.25 + recency × 0.1 + frequency × 0.05.
   */
  search(query: string, scopes: ScopeFilter[], limit = 8): Array<Memory & { score: number }> {
    if (!scopes.length) return []
    const scopeSql = scopes.map(() => "(m.scope = ? AND IFNULL(m.scope_id, '') = IFNULL(?, ''))").join(' OR ')
    const scopeParams = scopes.flatMap((s) => [s.scope, s.scope === 'global' ? null : (s.scopeId ?? null)])
    const q = ftsQuery(query)
    let rows: Row[]
    if (q) {
      rows = this.db.all<Row>(
        `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND (${scopeSql}) ORDER BY rank LIMIT ?`,
        [q, ...scopeParams, limit * 4],
      )
    } else {
      rows = this.db.all<Row>(`SELECT m.* FROM memories m WHERE ${scopeSql} ORDER BY importance DESC, updated_at DESC LIMIT ?`, [...scopeParams, limit])
    }
    const nowMs = Date.now()
    const ranks = rows.map((r) => -(r.rank ?? 0))
    const maxRank = Math.max(1e-9, ...ranks)
    const scored = rows.map((r, i) => {
      const relevance = q ? ranks[i]! / maxRank : 0.5
      const ageDays = (nowMs - new Date(r.updated_at).getTime()) / 86_400_000
      const recency = Math.exp(-ageDays / 30)
      const frequency = Math.min(1, Math.log1p(r.access_count) / 4)
      return { ...toMemory(r), score: Math.round((relevance * 0.6 + r.importance * 0.25 + recency * 0.1 + frequency * 0.05) * 1000) / 1000 }
    })
    const top = scored.sort((a, b) => b.score - a.score).slice(0, limit)
    if (top.length) {
      const ts = now()
      this.db.transaction(() => {
        for (const m of top) this.db.run('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?', [ts, m.id])
      })
    }
    return top
  }

  /** Remove low-value memories beyond a per-scope cap. */
  prune(maxPerScope = 2000): number {
    const scopes = this.db.all<{ scope: string; scope_id: string | null; n: number }>('SELECT scope, scope_id, COUNT(*) AS n FROM memories GROUP BY scope, scope_id HAVING n > ?', [maxPerScope])
    let removed = 0
    for (const s of scopes) {
      removed += this.db.run(
        `DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE scope = ? AND IFNULL(scope_id,'') = IFNULL(?, '')
         ORDER BY importance ASC, access_count ASC, updated_at ASC LIMIT ?)`,
        [s.scope, s.scope_id, s.n - maxPerScope],
      ).changes
    }
    return removed
  }

  stats() {
    return this.db.all<{ scope: string; n: number }>('SELECT scope, COUNT(*) AS n FROM memories GROUP BY scope')
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v))
}
