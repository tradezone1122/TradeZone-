/**
 * Module 23: Terminal Manager
 *
 * Interactive shell sessions for the Web IDE. Uses a real pseudo-terminal
 * (node-pty) when available and falls back to a piped bash process. Output is
 * streamed over the event bus (`terminal:<id>`) to WebSocket clients, with a
 * scrollback buffer for reconnects, idle reaping and a per-server cap.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import type { EventBus } from '../events/bus.js'
import { newId } from '../db/database.js'
import { childEnv } from './process.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../core/errors.js'
import type { PlatformMetrics } from '../monitoring/metrics.js'

interface PtyLike {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  pid: number
}

export interface TerminalInfo {
  id: string
  userId: string
  projectId: string | null
  cwd: string
  pty: boolean
  cols: number
  rows: number
  createdAt: string
  lastActivity: string
  alive: boolean
}

interface Session extends TerminalInfo {
  proc: PtyLike
  scrollback: string
}

const require = createRequire(import.meta.url)
let ptyModule: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => PtyLike } | null | undefined

function loadPty() {
  if (ptyModule !== undefined) return ptyModule
  try {
    ptyModule = require('@lydell/node-pty')
  } catch {
    ptyModule = null
  }
  return ptyModule
}

function pipeProcess(cwd: string, env: Record<string, string>): PtyLike {
  const child: ChildProcessWithoutNullStreams = spawn('bash', ['-i'], { cwd, env: { ...env, PS1: '\\w $ ' } })
  const dataCbs: Array<(d: string) => void> = []
  child.stdout.on('data', (d: Buffer) => dataCbs.forEach((cb) => cb(d.toString('utf8'))))
  child.stderr.on('data', (d: Buffer) => dataCbs.forEach((cb) => cb(d.toString('utf8'))))
  return {
    pid: child.pid ?? 0,
    write: (data) => child.stdin.write(data.replace(/\r/g, '\n')),
    resize: () => undefined,
    kill: (sig) => child.kill((sig as NodeJS.Signals) ?? 'SIGTERM'),
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => child.on('exit', (code) => cb({ exitCode: code ?? 0 })),
  }
}

export class TerminalManager {
  private sessions = new Map<string, Session>()
  private reaper: NodeJS.Timeout

  constructor(
    private readonly bus: EventBus,
    private readonly metrics: PlatformMetrics,
    private readonly maxSessions: number,
    private readonly idleMs = 60 * 60_000,
  ) {
    this.reaper = setInterval(() => this.reap(), 60_000)
    this.reaper.unref()
  }

  create(userId: string, cwd: string, opts: { projectId?: string; cols?: number; rows?: number } = {}): TerminalInfo {
    if (this.sessions.size >= this.maxSessions) throw new ConflictError(`Terminal limit reached (${this.maxSessions})`)
    const id = newId('term')
    const cols = opts.cols ?? 120
    const rows = opts.rows ?? 30
    const env = { ...childEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' }
    const pty = loadPty()
    let proc: PtyLike
    let isPty = false
    if (pty) {
      try {
        proc = pty.spawn(process.env.SHELL && !process.env.SHELL.endsWith('nologin') ? process.env.SHELL : 'bash', [], { name: 'xterm-256color', cols, rows, cwd, env })
        isPty = true
      } catch {
        proc = pipeProcess(cwd, env)
      }
    } else proc = pipeProcess(cwd, env)
    const ts = new Date().toISOString()
    const session: Session = { id, userId, projectId: opts.projectId ?? null, cwd, pty: isPty, cols, rows, createdAt: ts, lastActivity: ts, alive: true, proc, scrollback: '' }
    proc.onData((data) => {
      session.scrollback = (session.scrollback + data).slice(-200_000)
      session.lastActivity = new Date().toISOString()
      this.bus.publish(`terminal:${id}`, 'terminal.output', { data })
    })
    proc.onExit(({ exitCode }) => {
      session.alive = false
      this.bus.publish(`terminal:${id}`, 'terminal.exit', { exitCode })
      this.sessions.delete(id)
      this.metrics.terminalSessions.set(this.sessions.size)
    })
    this.sessions.set(id, session)
    this.metrics.terminalSessions.set(this.sessions.size)
    return this.info(session)
  }

  private info(s: Session): TerminalInfo {
    const { proc: _p, scrollback: _s, ...rest } = s
    return rest
  }

  private own(id: string, userId: string, isAdmin: boolean): Session {
    const s = this.sessions.get(id)
    if (!s) throw new NotFoundError('Terminal session')
    if (s.userId !== userId && !isAdmin) throw new ForbiddenError('Not your terminal session')
    return s
  }

  list(userId: string, isAdmin: boolean): TerminalInfo[] {
    return [...this.sessions.values()].filter((s) => isAdmin || s.userId === userId).map((s) => this.info(s))
  }

  write(id: string, userId: string, isAdmin: boolean, data: string): void {
    const s = this.own(id, userId, isAdmin)
    s.lastActivity = new Date().toISOString()
    s.proc.write(data)
  }

  resize(id: string, userId: string, isAdmin: boolean, cols: number, rows: number): void {
    const s = this.own(id, userId, isAdmin)
    s.cols = Math.max(10, Math.min(500, cols))
    s.rows = Math.max(5, Math.min(200, rows))
    s.proc.resize(s.cols, s.rows)
  }

  scrollback(id: string, userId: string, isAdmin: boolean): string {
    return this.own(id, userId, isAdmin).scrollback
  }

  kill(id: string, userId: string, isAdmin: boolean): void {
    const s = this.own(id, userId, isAdmin)
    try {
      s.proc.kill()
    } catch {
      /* already exited */
    }
    this.sessions.delete(id)
    this.metrics.terminalSessions.set(this.sessions.size)
  }

  canAccess(id: string, userId: string, isAdmin: boolean): boolean {
    const s = this.sessions.get(id)
    return !!s && (s.userId === userId || isAdmin)
  }

  private reap(): void {
    const cutoff = Date.now() - this.idleMs
    for (const s of this.sessions.values()) {
      if (new Date(s.lastActivity).getTime() < cutoff) {
        try {
          s.proc.kill()
        } catch {
          /* ignore */
        }
        this.sessions.delete(s.id)
      }
    }
    this.metrics.terminalSessions.set(this.sessions.size)
  }

  shutdown(): void {
    clearInterval(this.reaper)
    for (const s of this.sessions.values()) {
      try {
        s.proc.kill()
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear()
  }
}
