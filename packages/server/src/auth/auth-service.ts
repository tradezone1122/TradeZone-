/**
 * Module 30: Authentication System
 *
 * - Password hashing with scrypt (per-user salt, constant-time verify).
 * - HS256 JSON Web Tokens with expiry and per-user token versioning
 *   (incrementing `token_version` revokes every outstanding token).
 * - Personal API keys (`tz_...`), stored as SHA-256 hashes, with scopes.
 * - First-run setup and environment-based admin bootstrap.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import { sha256 } from '../security/sandbox.js'
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../core/errors.js'

export type Role = 'admin' | 'developer' | 'viewer'

export interface User {
  id: string
  username: string
  email: string | null
  displayName: string | null
  role: Role
  disabled: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface AuthPrincipal {
  user: User
  via: 'jwt' | 'api_key'
  scopes: string[] | null
}

interface UserRow {
  id: string
  username: string
  email: string | null
  display_name: string | null
  password_hash: string
  role: Role
  disabled: number
  token_version: number
  last_login_at: string | null
  created_at: string
}

const SCRYPT_N = 16384

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N })
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, nStr, saltB64, hashB64] = stored.split('$')
  if (alg !== 'scrypt' || !nStr || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(nStr) })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export interface JwtPayload {
  sub: string
  ver: number
  role: Role
  iat: number
  exp: number
}

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string, ttlSeconds: number): string {
  const iat = Math.floor(Date.now() / 1000)
  const body: JwtPayload = { ...payload, iat, exp: iat + ttlSeconds }
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const content = b64url(JSON.stringify(body))
  const sig = createHmac('sha256', secret).update(`${header}.${content}`).digest('base64url')
  return `${header}.${content}.${sig}`
}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new UnauthorizedError('Malformed token')
  const [header, content, sig] = parts as [string, string, string]
  const expected = createHmac('sha256', secret).update(`${header}.${content}`).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedError('Invalid token signature')
  const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string }
  if (h.alg !== 'HS256') throw new UnauthorizedError('Unsupported token algorithm')
  const payload = JSON.parse(Buffer.from(content, 'base64url').toString('utf8')) as JwtPayload
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) throw new UnauthorizedError('Token expired')
  return payload
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    disabled: !!r.disabled,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  }
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  needsSetup(): boolean {
    return (this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0) === 0
  }

  createUser(input: { username: string; password: string; email?: string | null; displayName?: string | null; role: Role }): User {
    if (!USERNAME_RE.test(input.username)) throw new ValidationError('Username must be 3-32 characters: letters, digits, _ . -')
    if (input.password.length < 8) throw new ValidationError('Password must be at least 8 characters')
    if (this.db.get('SELECT id FROM users WHERE username = ?', [input.username])) throw new ConflictError('Username already exists')
    if (input.email && this.db.get('SELECT id FROM users WHERE email = ?', [input.email])) throw new ConflictError('Email already in use')
    const ts = now()
    const id = newId('usr')
    this.db.insert('users', {
      id,
      username: input.username,
      email: input.email ?? null,
      display_name: input.displayName ?? null,
      password_hash: hashPassword(input.password),
      role: input.role,
      disabled: 0,
      token_version: 0,
      created_at: ts,
      updated_at: ts,
    })
    return this.getUser(id)
  }

  getUser(id: string): User {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id])
    if (!row) throw new NotFoundError('User')
    return toUser(row)
  }

  listUsers(): User[] {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY created_at').map(toUser)
  }

  updateUser(id: string, patch: { email?: string | null; displayName?: string | null; role?: Role; disabled?: boolean; password?: string }): User {
    this.getUser(id)
    const row: Record<string, unknown> = { updated_at: now() }
    if (patch.email !== undefined) row.email = patch.email
    if (patch.displayName !== undefined) row.display_name = patch.displayName
    if (patch.role !== undefined) {
      if (patch.role !== 'admin') this.assertNotLastAdmin(id)
      row.role = patch.role
    }
    if (patch.disabled !== undefined) {
      if (patch.disabled) this.assertNotLastAdmin(id)
      row.disabled = patch.disabled ? 1 : 0
    }
    if (patch.password !== undefined) {
      if (patch.password.length < 8) throw new ValidationError('Password must be at least 8 characters')
      row.password_hash = hashPassword(patch.password)
    }
    if (patch.password !== undefined || patch.disabled || patch.role !== undefined) {
      this.db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [id])
    }
    this.db.update('users', id, row)
    return this.getUser(id)
  }

  deleteUser(id: string): void {
    this.assertNotLastAdmin(id)
    this.db.transaction(() => {
      this.db.run('UPDATE projects SET owner_id = (SELECT id FROM users WHERE role = \'admin\' AND id != ? ORDER BY created_at LIMIT 1) WHERE owner_id = ?', [id, id])
      this.db.run('DELETE FROM users WHERE id = ?', [id])
    })
  }

  private assertNotLastAdmin(id: string): void {
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id])
    if (user?.role !== 'admin') return
    const admins = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")?.n ?? 0
    if (admins <= 1) throw new ConflictError('Cannot remove, demote or disable the last active administrator')
  }

  login(username: string, password: string): { token: string; user: User; expiresIn: number } {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE username = ? OR email = ?', [username, username])
    // Always run a hash comparison to keep timing uniform.
    const ok = row ? verifyPassword(password, row.password_hash) : verifyPassword(password, hashPassword('timing-dummy'))
    if (!row || !ok) throw new UnauthorizedError('Invalid username or password')
    if (row.disabled) throw new UnauthorizedError('Account disabled')
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), row.id])
    const token = signJwt({ sub: row.id, ver: row.token_version, role: row.role }, this.secret, this.ttlSeconds)
    return { token, user: toUser({ ...row, last_login_at: now() }), expiresIn: this.ttlSeconds }
  }

  changePassword(userId: string, current: string, next: string): void {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [userId])
    if (!row || !verifyPassword(current, row.password_hash)) throw new UnauthorizedError('Current password is incorrect')
    this.updateUser(userId, { password: next })
  }

  /** Authenticate a bearer credential: JWT or `tz_` API key. */
  authenticate(credential: string): AuthPrincipal {
    if (credential.startsWith('tz_')) return this.authenticateApiKey(credential)
    const payload = verifyJwt(credential, this.secret)
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [payload.sub])
    if (!row) throw new UnauthorizedError('User no longer exists')
    if (row.disabled) throw new UnauthorizedError('Account disabled')
    if (row.token_version !== payload.ver) throw new UnauthorizedError('Token revoked')
    return { user: toUser(row), via: 'jwt', scopes: null }
  }

  logoutEverywhere(userId: string): void {
    this.db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId])
  }

  createApiKey(userId: string, name: string, scopes: string[] = [], expiresAt?: string | null): { key: string; id: string; prefix: string } {
    const key = `tz_${randomBytes(24).toString('base64url').replace(/[-_]/g, 'x')}`
    const id = newId('key')
    const prefix = key.slice(0, 10)
    this.db.insert('api_keys', {
      id,
      user_id: userId,
      name,
      prefix,
      key_hash: sha256(key),
      scopes: JSON.stringify(scopes),
      expires_at: expiresAt ?? null,
      revoked: 0,
      created_at: now(),
    })
    return { key, id, prefix }
  }

  listApiKeys(userId: string) {
    return this.db
      .all<{ id: string; name: string; prefix: string; scopes: string; last_used_at: string | null; expires_at: string | null; revoked: number; created_at: string }>(
        'SELECT id, name, prefix, scopes, last_used_at, expires_at, revoked, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
      )
      .map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, scopes: parseJson<string[]>(r.scopes, []), lastUsedAt: r.last_used_at, expiresAt: r.expires_at, revoked: !!r.revoked, createdAt: r.created_at }))
  }

  revokeApiKey(userId: string, keyId: string, isAdmin: boolean): void {
    const res = isAdmin
      ? this.db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [keyId])
      : this.db.run('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?', [keyId, userId])
    if (!res.changes) throw new NotFoundError('API key')
  }

  private authenticateApiKey(key: string): AuthPrincipal {
    const row = this.db.get<{ id: string; user_id: string; scopes: string; expires_at: string | null; revoked: number }>(
      'SELECT id, user_id, scopes, expires_at, revoked FROM api_keys WHERE key_hash = ?',
      [sha256(key)],
    )
    if (!row || row.revoked) throw new UnauthorizedError('Invalid API key')
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) throw new UnauthorizedError('API key expired')
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [row.user_id])
    if (!user || user.disabled) throw new UnauthorizedError('API key owner is disabled')
    this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now(), row.id])
    const scopes = parseJson<string[]>(row.scopes, [])
    return { user: toUser(user), via: 'api_key', scopes: scopes.length ? scopes : null }
  }

  bootstrapAdmin(username?: string, password?: string, email?: string): User | null {
    if (!this.needsSetup() || !username || !password) return null
    return this.createUser({ username, password, email: email ?? null, role: 'admin', displayName: 'Administrator' })
  }
}
