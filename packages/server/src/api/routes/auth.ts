import { z } from 'zod'
import type { Api } from '../http.js'
import { IdParams } from '../http.js'
import { ForbiddenError, ValidationError } from '../../core/errors.js'
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../authz/rbac.js'

const Role = z.enum(['admin', 'developer', 'viewer'])

export function authRoutes(api: Api): void {
  const { auth, settings, audit } = api.services

  api.get('/api/auth/status', { perm: 'public' }, () => ({
    needsSetup: auth.needsSetup(),
    allowRegistration: settings.get<boolean>('security.allowRegistration'),
    platformName: settings.get<string>('platform.name'),
    version: '1.0.0',
  }))

  api.post('/api/auth/setup', { perm: 'public', body: z.object({ username: z.string(), password: z.string(), email: z.string().email().optional() }) }, ({ body, req }) => {
    if (!auth.needsSetup()) throw new ForbiddenError('Setup has already been completed')
    const user = auth.createUser({ ...body, role: 'admin', displayName: 'Administrator' })
    audit.record({ userId: user.id, action: 'auth.setup', ip: req.ip })
    return auth.login(body.username, body.password)
  })

  api.post('/api/auth/register', { perm: 'public', body: z.object({ username: z.string(), password: z.string(), email: z.string().email().optional(), displayName: z.string().max(80).optional() }) }, ({ body, req }) => {
    if (!settings.get<boolean>('security.allowRegistration')) throw new ForbiddenError('Self-registration is disabled')
    const user = auth.createUser({ ...body, role: 'developer' })
    audit.record({ userId: user.id, action: 'auth.register', ip: req.ip })
    return auth.login(body.username, body.password)
  })

  api.post('/api/auth/login', { perm: 'public', body: z.object({ username: z.string().min(1), password: z.string().min(1) }) }, ({ body, req }) => {
    try {
      const res = auth.login(body.username, body.password)
      audit.record({ userId: res.user.id, action: 'auth.login', ip: req.ip })
      return res
    } catch (e) {
      audit.record({ action: 'auth.login_failed', target: body.username, ip: req.ip })
      throw e
    }
  })

  api.get('/api/auth/me', { perm: null }, ({ principal }) => ({
    user: principal.user,
    via: principal.via,
    permissions: [...ROLE_PERMISSIONS[principal.user.role]].filter((p) => !principal.scopes || principal.scopes.includes(p) || principal.scopes.includes('*')),
  }))

  api.post('/api/auth/logout-all', { perm: null, audit: 'auth.logout_all' }, ({ principal }) => {
    auth.logoutEverywhere(principal.user.id)
    return { ok: true }
  })

  api.post('/api/auth/change-password', { perm: null, audit: 'auth.change_password', body: z.object({ currentPassword: z.string(), newPassword: z.string().min(8) }) }, ({ principal, body }) => {
    auth.changePassword(principal.user.id, body.currentPassword, body.newPassword)
    return { ok: true }
  })

  api.get('/api/auth/permissions', { perm: null }, () => ({ permissions: PERMISSIONS, roles: Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([r, s]) => [r, [...s]])) }))

  // ---- API keys
  api.get('/api/auth/api-keys', { perm: null }, ({ principal }) => auth.listApiKeys(principal.user.id))
  api.post('/api/auth/api-keys', { perm: null, audit: 'apikey.create', body: z.object({ name: z.string().min(1).max(80), scopes: z.array(z.string()).optional(), expiresAt: z.string().datetime().optional() }) }, ({ principal, body }) => {
    if (principal.via === 'api_key') throw new ForbiddenError('API keys cannot create API keys')
    for (const s of body.scopes ?? []) if (s !== '*' && !(PERMISSIONS as readonly string[]).includes(s)) throw new ValidationError(`Unknown scope '${s}'`)
    return auth.createApiKey(principal.user.id, body.name, body.scopes ?? [], body.expiresAt ?? null)
  })
  api.delete('/api/auth/api-keys/:id', { perm: null, audit: 'apikey.revoke', params: IdParams }, ({ principal, params }) => {
    auth.revokeApiKey(principal.user.id, params.id, principal.user.role === 'admin')
  })

  // ---- Users (admin)
  api.get('/api/users', { perm: 'users:manage' }, () => auth.listUsers())
  api.get('/api/users/directory', { perm: null }, () => auth.listUsers().filter((u) => !u.disabled).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })))
  api.post('/api/users', { perm: 'users:manage', audit: 'user.create', body: z.object({ username: z.string(), password: z.string(), email: z.string().email().nullish(), displayName: z.string().max(80).nullish(), role: Role }) }, ({ body }) => auth.createUser(body))
  api.patch('/api/users/:id', { perm: 'users:manage', audit: 'user.update', params: IdParams, body: z.object({ email: z.string().email().nullish(), displayName: z.string().max(80).nullish(), role: Role.optional(), disabled: z.boolean().optional(), password: z.string().min(8).optional() }) }, ({ params, body }) => auth.updateUser(params.id, body))
  api.delete('/api/users/:id', { perm: 'users:manage', audit: 'user.delete', params: IdParams }, ({ params, principal }) => {
    if (params.id === principal.user.id) throw new ValidationError('You cannot delete your own account')
    auth.deleteUser(params.id)
  })
}
