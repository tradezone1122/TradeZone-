/**
 * Module 33: API Server
 *
 * Fastify application: security headers, CORS, rate limiting, request
 * metrics and logging, error mapping, health/readiness probes, Prometheus
 * metrics, WebSocket endpoint, static frontend and deployment hosting, and
 * all REST routes.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { ZodError } from 'zod'
import type { PlatformServices } from '../platform.js'
import { AppError } from '../core/errors.js'
import { SecurityError } from '../security/sandbox.js'
import { Api } from './http.js'
import { authRoutes } from './routes/auth.js'
import { projectRoutes } from './routes/projects.js'
import { agentRoutes } from './routes/agents.js'
import { platformRoutes } from './routes/platform.js'
import { registerWebSocket } from '../ws/ws-server.js'

export async function buildServer(s: PlatformServices): Promise<{ app: FastifyInstance; api: Api }> {
  const log = s.log.child('http')
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024, trustProxy: true, disableRequestLogging: true })

  await app.register(cors, {
    origin: s.config.corsOrigins.length ? s.config.corsOrigins : s.config.env !== 'production',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  await app.register(rateLimit, {
    max: s.config.rateLimitPerMinute,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health' || req.url === '/ready' || req.url.startsWith('/assets/'),
    keyGenerator: (req) => (req.headers.authorization ? `auth:${req.headers.authorization.slice(-24)}` : `ip:${req.ip}`),
  })
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } })

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'SAMEORIGIN')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    ;(req as unknown as { startedAt: number }).startedAt = performance.now()
  })
  app.addHook('onResponse', async (req, reply) => {
    const ms = performance.now() - ((req as unknown as { startedAt?: number }).startedAt ?? performance.now())
    const route = req.routeOptions?.url ?? 'unmatched'
    s.metrics.httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) })
    s.metrics.httpDuration.observe(ms, { method: req.method })
    if (reply.statusCode >= 500) log.error('Request failed', { method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(ms) })
    else if (route.startsWith('/api/')) log.debug('Request', { method: req.method, route, status: reply.statusCode, ms: Math.round(ms) })
  })

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; validation?: unknown; code?: string }
    if (e instanceof AppError) return reply.code(e.statusCode).send({ error: e.code, message: e.message, details: e.details })
    if (e instanceof SecurityError) return reply.code(403).send({ error: 'security_violation', message: e.message })
    if (e instanceof ZodError) return reply.code(400).send({ error: 'validation_error', message: e.issues.map((i) => i.message).join('; ') })
    if (e.statusCode === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests' })
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message })
    log.error('Unhandled error', { method: req.method, url: req.url, error: e })
    return reply.code(500).send({ error: 'internal_error', message: s.config.env === 'production' ? 'Internal server error' : e.message })
  })

  app.get('/health', async () => ({ status: 'ok', uptime: Math.round(process.uptime()) }))
  app.get('/ready', async (_req, reply) => {
    try {
      s.db.get('SELECT 1')
      return { status: 'ready', providers: s.providers.list().filter((p) => p.enabled).length, needsSetup: s.auth.needsSetup() }
    } catch (err) {
      return reply.code(503).send({ status: 'not_ready', error: err instanceof Error ? err.message : String(err) })
    }
  })
  app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(s.metricsRegistry.renderPrometheus()))

  const api = new Api(app, s)
  authRoutes(api)
  projectRoutes(api)
  agentRoutes(api)
  platformRoutes(api)
  registerWebSocket(app, s)

  // Hosted static deployments.
  mkdirSync(s.deploy.deploymentsDir, { recursive: true })
  await app.register(fastifyStatic, { root: s.deploy.deploymentsDir, prefix: '/deployments/', decorateReply: false })

  // Frontend (single-page app) when built.
  const webDist = s.config.webDistDir ?? path.resolve(process.cwd(), 'apps/web/dist')
  if (existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws') || req.method !== 'GET') return reply.code(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found` })
      return reply.sendFile('index.html', webDist)
    })
    log.info('Serving web frontend', { dir: webDist })
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found` }))
  }
  return { app, api }
}
