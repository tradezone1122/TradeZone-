/**
 * Module 33 (part): route definition helpers — authentication, permission
 * checks, zod validation and consistent JSON errors for every endpoint.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z, type ZodType } from 'zod'
import type { AuthPrincipal } from '../auth/auth-service.js'
import { requirePermission, type Permission } from '../authz/rbac.js'
import { UnauthorizedError, ValidationError } from '../core/errors.js'
import type { PlatformServices } from '../platform.js'

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthPrincipal
  }
}

export interface RouteContext<B, Q, P> {
  req: FastifyRequest
  reply: FastifyReply
  principal: AuthPrincipal
  body: B
  query: Q
  params: P
  services: PlatformServices
}

export interface RouteOptions<B, Q, P> {
  /** Required permission; `null` for authenticated-only; `'public'` for no auth. */
  perm: Permission | null | 'public'
  body?: ZodType<B>
  query?: ZodType<Q>
  params?: ZodType<P>
  /** Audit-log action name for mutating routes. */
  audit?: string
}

export function extractToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) return h.slice(7).trim()
  const key = req.headers['x-api-key']
  if (typeof key === 'string') return key
  const q = (req.query as Record<string, unknown> | undefined)?.token
  if (typeof q === 'string' && req.url.startsWith('/ws')) return q
  return null
}

function parse<T>(schema: ZodType<T> | undefined, value: unknown, where: string): T {
  if (!schema) return value as T
  const r = schema.safeParse(value ?? {})
  if (!r.success) {
    throw new ValidationError(`Invalid ${where}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`, r.error.issues)
  }
  return r.data
}

export class Api {
  constructor(
    readonly app: FastifyInstance,
    readonly services: PlatformServices,
  ) {}

  /** Number of routes registered through this helper. */
  count = 0
  readonly routes: Array<{ method: string; url: string; perm: string }> = []

  private register<B, Q, P>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, opts: RouteOptions<B, Q, P>, handler: (ctx: RouteContext<B, Q, P>) => unknown) {
    this.count++
    this.routes.push({ method, url, perm: opts.perm === null ? 'authenticated' : String(opts.perm) })
    this.app.route({
      method,
      url,
      handler: async (req, reply) => {
        let principal = req.principal
        if (opts.perm !== 'public') {
          if (!principal) {
            const token = extractToken(req)
            if (!token) throw new UnauthorizedError()
            principal = this.services.auth.authenticate(token)
            req.principal = principal
          }
          if (opts.perm) requirePermission(principal, opts.perm)
        }
        const ctx: RouteContext<B, Q, P> = {
          req,
          reply,
          principal: principal as AuthPrincipal,
          body: parse(opts.body, req.body, 'request body'),
          query: parse(opts.query, req.query, 'query'),
          params: parse(opts.params, req.params, 'path parameters'),
          services: this.services,
        }
        const result = await handler(ctx)
        if (opts.audit) {
          this.services.audit.record({ userId: principal?.user.id ?? null, action: opts.audit, target: (req.params as Record<string, string>)?.id ?? null, details: sanitizeForAudit(req.body), ip: req.ip })
        }
        if (reply.sent) return reply
        if (result === undefined) return reply.code(204).send()
        return result
      },
    })
  }

  get<Q = unknown, P = unknown>(url: string, opts: RouteOptions<unknown, Q, P>, h: (ctx: RouteContext<unknown, Q, P>) => unknown) {
    this.register('GET', url, opts, h)
  }
  post<B = unknown, Q = unknown, P = unknown>(url: string, opts: RouteOptions<B, Q, P>, h: (ctx: RouteContext<B, Q, P>) => unknown) {
    this.register('POST', url, opts, h)
  }
  put<B = unknown, Q = unknown, P = unknown>(url: string, opts: RouteOptions<B, Q, P>, h: (ctx: RouteContext<B, Q, P>) => unknown) {
    this.register('PUT', url, opts, h)
  }
  patch<B = unknown, Q = unknown, P = unknown>(url: string, opts: RouteOptions<B, Q, P>, h: (ctx: RouteContext<B, Q, P>) => unknown) {
    this.register('PATCH', url, opts, h)
  }
  delete<B = unknown, Q = unknown, P = unknown>(url: string, opts: RouteOptions<B, Q, P>, h: (ctx: RouteContext<B, Q, P>) => unknown) {
    this.register('DELETE', url, opts, h)
  }
}

function sanitizeForAudit(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (/pass|secret|token|key|content|env|headers/i.test(k)) out[k] = '[omitted]'
    else out[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v
  }
  return out
}

export const IdParams = z.object({ id: z.string().min(1) })
export const Pagination = z.object({ limit: z.coerce.number().int().min(1).max(1000).optional(), offset: z.coerce.number().int().min(0).optional() })
