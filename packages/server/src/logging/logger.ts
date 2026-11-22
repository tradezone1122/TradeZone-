/**
 * Module 39: Logging System
 *
 * Structured JSON logger with levels, child contexts, secret redaction, an
 * in-memory ring buffer (for the live log viewer) and pluggable sinks (stdout,
 * database persistence, WebSocket broadcast).
 */
import { redactSecrets } from '../security/secrets.js'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export const LEVEL_ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 }

export interface LogRecord {
  id: number
  time: string
  level: LogLevel
  msg: string
  module?: string
  context?: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

class LogHub {
  level: LogLevel = 'info'
  private seq = 0
  private buffer: LogRecord[] = []
  private readonly capacity = 2000
  private sinks = new Set<LogSink>()
  stdout = true

  addSink(sink: LogSink): () => void {
    this.sinks.add(sink)
    return () => this.sinks.delete(sink)
  }

  emit(level: LogLevel, msg: string, module: string | undefined, context: Record<string, unknown> | undefined): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const record: LogRecord = {
      id: ++this.seq,
      time: new Date().toISOString(),
      level,
      msg: redactSecrets(msg),
      module,
      context: context ? (sanitizeContext(context) as Record<string, unknown>) : undefined,
    }
    this.buffer.push(record)
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity)
    if (this.stdout) {
      const line = JSON.stringify(record)
      if (LEVEL_ORDER[level] >= LEVEL_ORDER.warn) process.stderr.write(line + '\n')
      else process.stdout.write(line + '\n')
    }
    for (const sink of this.sinks) {
      try {
        sink(record)
      } catch {
        // Sinks must never break logging.
      }
    }
  }

  recent(opts: { level?: LogLevel; module?: string; limit?: number; search?: string } = {}): LogRecord[] {
    const min = opts.level ? LEVEL_ORDER[opts.level] : 0
    const search = opts.search?.toLowerCase()
    const out = this.buffer.filter(
      (r) =>
        LEVEL_ORDER[r.level] >= min &&
        (!opts.module || r.module === opts.module) &&
        (!search || r.msg.toLowerCase().includes(search) || JSON.stringify(r.context ?? {}).toLowerCase().includes(search)),
    )
    return out.slice(-(opts.limit ?? 500))
  }
}

function sanitizeContext(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth]'
  if (value instanceof Error) return { name: value.name, message: redactSecrets(value.message), stack: value.stack?.split('\n').slice(0, 8).join('\n') }
  if (typeof value === 'string') return redactSecrets(value.length > 4000 ? value.slice(0, 4000) + '…' : value)
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeContext(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (/pass(word)?|secret|token|api[_-]?key|authorization/i.test(k)) out[k] = '[redacted]'
      else out[k] = sanitizeContext(v, depth + 1)
    }
    return out
  }
  return value
}

export const logHub = new LogHub()

export class Logger {
  constructor(
    private readonly module?: string,
    private readonly base: Record<string, unknown> = {},
  ) {}

  child(module: string, base: Record<string, unknown> = {}): Logger {
    return new Logger(module, { ...this.base, ...base })
  }

  private log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    const merged = Object.keys(this.base).length || ctx ? { ...this.base, ...ctx } : undefined
    logHub.emit(level, msg, this.module, merged)
  }

  trace(msg: string, ctx?: Record<string, unknown>): void { this.log('trace', msg, ctx) }
  debug(msg: string, ctx?: Record<string, unknown>): void { this.log('debug', msg, ctx) }
  info(msg: string, ctx?: Record<string, unknown>): void { this.log('info', msg, ctx) }
  warn(msg: string, ctx?: Record<string, unknown>): void { this.log('warn', msg, ctx) }
  error(msg: string, ctx?: Record<string, unknown>): void { this.log('error', msg, ctx) }
}

export const rootLogger = new Logger('app')
