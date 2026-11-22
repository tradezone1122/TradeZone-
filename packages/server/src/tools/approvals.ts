/**
 * Human-in-the-loop approvals for tool calls. A pending approval is stored in
 * the database and broadcast on the `approvals` topic; the executor waits for
 * a decision (from the UI over REST/WebSocket) or a timeout.
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { EventBus } from '../events/bus.js'
import { ConflictError, NotFoundError } from '../core/errors.js'

export interface Approval {
  id: string
  runId: string | null
  userId: string | null
  tool: string
  input: Record<string, unknown>
  reason: string | null
  status: 'pending' | 'approved' | 'denied' | 'expired'
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
}

interface Row {
  id: string
  run_id: string | null
  user_id: string | null
  tool: string
  input: string
  reason: string | null
  status: Approval['status']
  decided_by: string | null
  decided_at: string | null
  created_at: string
}

const toApproval = (r: Row): Approval => ({
  id: r.id,
  runId: r.run_id,
  userId: r.user_id,
  tool: r.tool,
  input: parseJson(r.input, {}),
  reason: r.reason,
  status: r.status,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  createdAt: r.created_at,
})

export class ApprovalService {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
  ) {}

  list(status?: Approval['status']): Approval[] {
    const rows = status
      ? this.db.all<Row>('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 200', [status])
      : this.db.all<Row>('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200')
    return rows.map(toApproval)
  }

  get(id: string): Approval {
    const r = this.db.get<Row>('SELECT * FROM approvals WHERE id = ?', [id])
    if (!r) throw new NotFoundError('Approval')
    return toApproval(r)
  }

  /** Create a pending approval and wait for the decision. Resolves true when approved. */
  async request(input: { runId?: string; userId?: string; tool: string; input: Record<string, unknown>; reason?: string }, timeoutMs = 10 * 60_000, signal?: AbortSignal): Promise<boolean> {
    const id = newId('appr')
    this.db.insert('approvals', {
      id,
      run_id: input.runId ?? null,
      user_id: input.userId ?? null,
      tool: input.tool,
      input: JSON.stringify(input.input),
      reason: input.reason ?? null,
      status: 'pending',
      created_at: now(),
    })
    const approval = this.get(id)
    this.bus.publish('approvals', 'approval.requested', approval)
    if (input.runId) this.bus.publish(`run:${input.runId}`, 'approval.requested', approval)
    try {
      const decided = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => {
          off()
          reject(new Error('timeout'))
        }, timeoutMs)
        const onAbort = () => {
          clearTimeout(timer)
          off()
          reject(new Error('aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        const off = this.bus.subscribe('approvals', (e) => {
          const a = e.data as Approval
          if (e.type === 'approval.decided' && a.id === id) {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            off()
            resolve(a.status === 'approved')
          }
        })
      })
      return decided
    } catch {
      this.db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", [now(), id])
      this.bus.publish('approvals', 'approval.expired', this.get(id))
      return false
    }
  }

  decide(id: string, approve: boolean, userId: string): Approval {
    const current = this.get(id)
    if (current.status !== 'pending') throw new ConflictError(`Approval already ${current.status}`)
    this.db.run('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [approve ? 'approved' : 'denied', userId, now(), id])
    const updated = this.get(id)
    this.bus.publish('approvals', 'approval.decided', updated)
    if (updated.runId) this.bus.publish(`run:${updated.runId}`, 'approval.decided', updated)
    return updated
  }
}
