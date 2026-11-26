/**
 * Module 34: WebSocket Server
 *
 * Authenticated, topic-based real-time channel. Clients connect to
 * `/ws?token=<jwt|api key>` and send JSON frames:
 *   {"type":"subscribe","topic":"run:<id>"}      {"type":"unsubscribe","topic":"..."}
 *   {"type":"terminal.input","id":"...","data":"ls\r"}
 *   {"type":"terminal.resize","id":"...","cols":120,"rows":30}
 *   {"type":"ping"}
 * Server frames: {"type":"event","topic","event","data","time"}, {"type":"subscribed"}, {"type":"error"}, {"type":"pong"}.
 * Every subscription is authorized against the topic's resource.
 */
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { PlatformServices } from '../platform.js'
import type { AuthPrincipal } from '../auth/auth-service.js'
import { hasPermission } from '../authz/rbac.js'
import { extractToken } from '../api/http.js'

const MAX_SUBSCRIPTIONS = 100

export function authorizeTopic(s: PlatformServices, principal: AuthPrincipal, topic: string): boolean {
  const isAdmin = principal.user.role === 'admin'
  const [kind, id] = topic.split(/:(.+)/) as [string, string | undefined]
  switch (kind) {
    case 'run': {
      if (!hasPermission(principal, 'agents:read') || !id) return false
      try {
        const run = s.runner.getRun(id)
        return isAdmin || run.userId === principal.user.id
      } catch {
        return false
      }
    }
    case 'team':
    case 'runs':
    case 'teams':
    case 'tasks':
    case 'approvals':
    case 'agents':
      return hasPermission(principal, 'agents:read')
    case 'project':
      if (!id || !hasPermission(principal, 'projects:read')) return false
      try {
        return s.projectAccess.accessLevel(principal, id) !== null
      } catch {
        return false
      }
    case 'terminal':
      return !!id && hasPermission(principal, 'terminal:use') && s.terminals.canAccess(id, principal.user.id, isAdmin)
    case 'mcp':
      return hasPermission(principal, 'mcp:read')
    case 'plugins':
      return hasPermission(principal, 'plugins:read')
    case 'system':
      return id === 'logs' ? hasPermission(principal, 'logs:read') : hasPermission(principal, 'monitoring:read')
    default:
      return false
  }
}

export function registerWebSocket(app: FastifyInstance, s: PlatformServices): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    let principal: AuthPrincipal
    try {
      const token = extractToken(req)
      if (!token) throw new Error('missing token')
      principal = s.auth.authenticate(token)
    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', error: 'unauthorized', message: err instanceof Error ? err.message : String(err) }))
      socket.close(4401, 'unauthorized')
      return
    }
    s.metrics.wsConnections.inc()
    const subs = new Map<string, () => void>()
    const send = (frame: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
    }
    send({ type: 'welcome', user: { id: principal.user.id, username: principal.user.username, role: principal.user.role } })
    const heartbeat = setInterval(() => send({ type: 'heartbeat', time: new Date().toISOString() }), 25_000)

    socket.on('message', (raw: Buffer) => {
      let msg: { type?: string; topic?: string; id?: string; data?: string; cols?: number; rows?: number; ref?: string }
      try {
        msg = JSON.parse(raw.toString('utf8'))
      } catch {
        send({ type: 'error', error: 'bad_json' })
        return
      }
      const isAdmin = principal.user.role === 'admin'
      try {
        switch (msg.type) {
          case 'ping':
            send({ type: 'pong', ref: msg.ref })
            break
          case 'subscribe': {
            const topic = String(msg.topic ?? '')
            if (subs.has(topic)) {
              send({ type: 'subscribed', topic })
              break
            }
            if (subs.size >= MAX_SUBSCRIPTIONS) throw new Error('Too many subscriptions')
            if (!authorizeTopic(s, principal, topic)) {
              send({ type: 'error', error: 'forbidden', topic })
              break
            }
            const off = s.bus.subscribe(topic.endsWith(':*') || !topic.includes(':') ? topic : topic, (e) => send({ type: 'event', topic: e.topic, event: e.type, data: e.data, time: e.time }))
            subs.set(topic, off)
            send({ type: 'subscribed', topic })
            if (topic.startsWith('terminal:')) {
              const id = topic.slice(9)
              send({ type: 'event', topic, event: 'terminal.scrollback', data: { data: s.terminals.scrollback(id, principal.user.id, isAdmin) }, time: new Date().toISOString() })
            }
            break
          }
          case 'unsubscribe': {
            const topic = String(msg.topic ?? '')
            subs.get(topic)?.()
            subs.delete(topic)
            send({ type: 'unsubscribed', topic })
            break
          }
          case 'terminal.input':
            if (!hasPermission(principal, 'terminal:use')) throw new Error('forbidden')
            s.terminals.write(String(msg.id), principal.user.id, isAdmin, String(msg.data ?? ''))
            break
          case 'terminal.resize':
            if (!hasPermission(principal, 'terminal:use')) throw new Error('forbidden')
            s.terminals.resize(String(msg.id), principal.user.id, isAdmin, Number(msg.cols) || 80, Number(msg.rows) || 24)
            break
          default:
            send({ type: 'error', error: 'unknown_type', received: msg.type })
        }
      } catch (err) {
        send({ type: 'error', error: 'failed', message: err instanceof Error ? err.message : String(err) })
      }
    })

    socket.on('close', () => {
      clearInterval(heartbeat)
      for (const off of subs.values()) off()
      subs.clear()
      s.metrics.wsConnections.dec()
    })
  })
}
