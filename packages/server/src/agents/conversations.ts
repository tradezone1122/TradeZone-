/**
 * Chat conversations: persistent message history that agent runs append to.
 * The chat UI sends a message, which starts an agent run with the stored
 * history; streaming output reaches the UI over WebSocket.
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { ChatMessage, ContentBlock } from '../core/types.js'
import { textOf } from '../core/types.js'
import { ForbiddenError, NotFoundError } from '../core/errors.js'

export interface Conversation {
  id: string
  userId: string
  projectId: string | null
  agentId: string | null
  title: string
  model: string | null
  createdAt: string
  updatedAt: string
  messageCount?: number
}

export interface StoredMessage {
  id: string
  seq: number
  role: 'user' | 'assistant'
  content: ContentBlock[]
  runId: string | null
  tokensIn: number | null
  tokensOut: number | null
  createdAt: string
}

interface Row {
  id: string
  user_id: string
  project_id: string | null
  agent_id: string | null
  title: string
  model: string | null
  created_at: string
  updated_at: string
  message_count?: number
}

const toConv = (r: Row): Conversation => ({ id: r.id, userId: r.user_id, projectId: r.project_id, agentId: r.agent_id, title: r.title, model: r.model, createdAt: r.created_at, updatedAt: r.updated_at, messageCount: r.message_count })

export class ConversationService {
  constructor(private readonly db: Database) {}

  create(userId: string, input: { title?: string; projectId?: string | null; agentId?: string | null; model?: string | null }): Conversation {
    const ts = now()
    const id = newId('conv')
    this.db.insert('conversations', { id, user_id: userId, project_id: input.projectId ?? null, agent_id: input.agentId ?? null, title: input.title?.trim() || 'New conversation', model: input.model ?? null, created_at: ts, updated_at: ts })
    return this.get(id, userId)
  }

  list(userId: string, projectId?: string): Conversation[] {
    const sql = `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c WHERE c.user_id = ? ${projectId ? 'AND c.project_id = ?' : ''} ORDER BY c.updated_at DESC LIMIT 200`
    return this.db.all<Row>(sql, projectId ? [userId, projectId] : [userId]).map(toConv)
  }

  get(id: string, userId: string, isAdmin = false): Conversation {
    const r = this.db.get<Row>('SELECT * FROM conversations WHERE id = ?', [id])
    if (!r) throw new NotFoundError('Conversation')
    if (r.user_id !== userId && !isAdmin) throw new ForbiddenError('Not your conversation')
    return toConv(r)
  }

  update(id: string, userId: string, patch: { title?: string; agentId?: string | null; model?: string | null; projectId?: string | null }): Conversation {
    this.get(id, userId)
    const row: Record<string, unknown> = { updated_at: now() }
    if (patch.title !== undefined) row.title = patch.title
    if (patch.agentId !== undefined) row.agent_id = patch.agentId
    if (patch.model !== undefined) row.model = patch.model
    if (patch.projectId !== undefined) row.project_id = patch.projectId
    this.db.update('conversations', id, row)
    return this.get(id, userId)
  }

  delete(id: string, userId: string, isAdmin = false): void {
    this.get(id, userId, isAdmin)
    this.db.run('DELETE FROM conversations WHERE id = ?', [id])
  }

  messages(id: string): StoredMessage[] {
    return this.db
      .all<{ id: string; seq: number; role: 'user' | 'assistant'; content: string; run_id: string | null; tokens_in: number | null; tokens_out: number | null; created_at: string }>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', [id])
      .map((m) => ({ id: m.id, seq: m.seq, role: m.role, content: parseJson(m.content, []), runId: m.run_id, tokensIn: m.tokens_in, tokensOut: m.tokens_out, createdAt: m.created_at }))
  }

  /** History as model messages (merging consecutive same-role messages). */
  history(id: string): ChatMessage[] {
    const out: ChatMessage[] = []
    for (const m of this.messages(id)) {
      const last = out.at(-1)
      if (last && last.role === m.role) last.content.push(...m.content)
      else out.push({ role: m.role, content: [...m.content] })
    }
    // A conversation must not end with an assistant tool_use lacking results.
    while (out.length && out.at(-1)!.role === 'assistant' && out.at(-1)!.content.some((b) => b.type === 'tool_use')) out.pop()
    return out
  }

  /** Give untitled conversations a title from the first user message. */
  autoTitle(id: string, firstMessage: string): void {
    const c = this.db.get<Row>('SELECT * FROM conversations WHERE id = ?', [id])
    if (c && c.title === 'New conversation') {
      const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation'
      this.db.update('conversations', id, { title })
    }
  }

  static preview(content: ContentBlock[]): string {
    return textOf(content).slice(0, 200)
  }
}
