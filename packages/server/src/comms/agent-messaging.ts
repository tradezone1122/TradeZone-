/**
 * Module 04: Agent Communication
 *
 * Persistent mailboxes and channels for agent-to-agent messaging. Messages
 * are stored in `agent_messages` and published on the event bus
 * (`agents:messages`, `team:<id>`) so the UI and listening agents see them in
 * real time. Agents use the `send_message` / `read_messages` tools; the
 * orchestrator uses channels to broadcast plans and results to a team.
 */
import type { Database } from '../db/database.js'
import { newId, now } from '../db/database.js'
import type { EventBus } from '../events/bus.js'
import { ValidationError } from '../core/errors.js'

export interface AgentMessage {
  id: string
  channel: string
  fromAgent: string
  toAgent: string | null
  teamRunId: string | null
  content: string
  readAt: string | null
  createdAt: string
}

interface Row {
  id: string
  channel: string
  from_agent: string
  to_agent: string | null
  team_run_id: string | null
  content: string
  read_at: string | null
  created_at: string
}

const toMsg = (r: Row): AgentMessage => ({ id: r.id, channel: r.channel, fromAgent: r.from_agent, toAgent: r.to_agent, teamRunId: r.team_run_id, content: r.content, readAt: r.read_at, createdAt: r.created_at })

export class AgentMessaging {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
  ) {}

  send(input: { from: string; to?: string | null; channel?: string; teamRunId?: string | null; content: string }): AgentMessage {
    const content = input.content.trim()
    if (!content) throw new ValidationError('Message is empty')
    if (content.length > 50_000) throw new ValidationError('Message exceeds 50,000 characters')
    const channel = input.channel ?? (input.teamRunId ? `team:${input.teamRunId}` : input.to ? `direct:${input.to}` : 'broadcast')
    const id = newId('amsg')
    this.db.insert('agent_messages', { id, channel, from_agent: input.from, to_agent: input.to ?? null, team_run_id: input.teamRunId ?? null, content, read_at: null, created_at: now() })
    const msg = toMsg(this.db.get<Row>('SELECT * FROM agent_messages WHERE id = ?', [id])!)
    this.bus.publish('agents:messages', 'agent.message', msg)
    if (msg.teamRunId) this.bus.publish(`team:${msg.teamRunId}`, 'agent.message', msg)
    return msg
  }

  /** Unread messages addressed to `agent` (direct) or to its team channel; marks them read. */
  inbox(agent: string, opts: { teamRunId?: string; markRead?: boolean; limit?: number } = {}): AgentMessage[] {
    const rows = opts.teamRunId
      ? this.db.all<Row>('SELECT * FROM agent_messages WHERE read_at IS NULL AND from_agent != ? AND (to_agent = ? OR (to_agent IS NULL AND team_run_id = ?)) ORDER BY created_at LIMIT ?', [agent, agent, opts.teamRunId, opts.limit ?? 50])
      : this.db.all<Row>('SELECT * FROM agent_messages WHERE read_at IS NULL AND to_agent = ? ORDER BY created_at LIMIT ?', [agent, opts.limit ?? 50])
    if (opts.markRead !== false && rows.length) {
      const ts = now()
      this.db.transaction(() => {
        // Team broadcasts stay unread for other members: only direct messages are marked read.
        for (const r of rows) if (r.to_agent === agent) this.db.run('UPDATE agent_messages SET read_at = ? WHERE id = ?', [ts, r.id])
      })
    }
    return rows.map(toMsg)
  }

  history(filter: { channel?: string; teamRunId?: string; agent?: string; limit?: number } = {}): AgentMessage[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.channel) { where.push('channel = ?'); params.push(filter.channel) }
    if (filter.teamRunId) { where.push('team_run_id = ?'); params.push(filter.teamRunId) }
    if (filter.agent) { where.push('(from_agent = ? OR to_agent = ?)'); params.push(filter.agent, filter.agent) }
    return this.db.all<Row>(`SELECT * FROM agent_messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`, [...params, filter.limit ?? 200]).map(toMsg).reverse()
  }

  /** Wait for the next message to `agent` (used by agents that block on a reply). */
  waitForMessage(agent: string, timeoutMs: number): Promise<AgentMessage | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve(null)
      }, timeoutMs)
      const off = this.bus.subscribe('agents:messages', (e) => {
        const m = e.data as AgentMessage
        if (m.toAgent === agent) {
          clearTimeout(timer)
          off()
          resolve(m)
        }
      })
    })
  }
}
