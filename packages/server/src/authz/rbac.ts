/**
 * Module 31: Authorization System
 *
 * Role-based access control with fine-grained permissions, API-key scope
 * restriction, and per-project membership roles (owner / editor / viewer).
 */
import type { Database } from '../db/database.js'
import type { AuthPrincipal, Role } from '../auth/auth-service.js'
import { ForbiddenError, NotFoundError } from '../core/errors.js'

export const PERMISSIONS = [
  'projects:read',
  'projects:write',
  'projects:delete',
  'files:read',
  'files:write',
  'terminal:use',
  'git:read',
  'git:write',
  'agents:read',
  'agents:write',
  'agents:run',
  'tasks:read',
  'tasks:write',
  'tools:read',
  'tools:execute',
  'memory:read',
  'memory:write',
  'prompts:read',
  'prompts:write',
  'mcp:read',
  'mcp:manage',
  'skills:read',
  'skills:manage',
  'plugins:read',
  'plugins:manage',
  'providers:read',
  'providers:manage',
  'review:run',
  'tests:run',
  'deploy:run',
  'monitoring:read',
  'logs:read',
  'users:manage',
  'settings:read',
  'settings:write',
  'approvals:decide',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const VIEWER: Permission[] = [
  'projects:read', 'files:read', 'git:read', 'agents:read', 'tasks:read', 'tools:read', 'memory:read', 'prompts:read',
  'mcp:read', 'skills:read', 'plugins:read', 'providers:read', 'settings:read',
]

const DEVELOPER: Permission[] = [
  ...VIEWER,
  'projects:write', 'projects:delete', 'files:write', 'terminal:use', 'git:write', 'agents:write', 'agents:run', 'tasks:write',
  'tools:execute', 'memory:write', 'prompts:write', 'review:run', 'tests:run', 'deploy:run', 'approvals:decide', 'monitoring:read',
]

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  developer: new Set(DEVELOPER),
  admin: new Set(PERMISSIONS),
}

export function hasPermission(principal: AuthPrincipal, permission: Permission): boolean {
  if (!ROLE_PERMISSIONS[principal.user.role].has(permission)) return false
  if (principal.scopes && !principal.scopes.includes(permission) && !principal.scopes.includes('*')) return false
  return true
}

export function requirePermission(principal: AuthPrincipal, permission: Permission): void {
  if (!hasPermission(principal, permission)) throw new ForbiddenError(`Missing permission: ${permission}`)
}

export type ProjectAccess = 'owner' | 'editor' | 'viewer'

const ACCESS_RANK: Record<ProjectAccess, number> = { viewer: 1, editor: 2, owner: 3 }

export class ProjectAccessControl {
  constructor(private readonly db: Database) {}

  accessLevel(principal: AuthPrincipal, projectId: string): ProjectAccess | null {
    const project = this.db.get<{ owner_id: string }>('SELECT owner_id FROM projects WHERE id = ?', [projectId])
    if (!project) throw new NotFoundError('Project')
    if (principal.user.role === 'admin') return 'owner'
    if (project.owner_id === principal.user.id) return 'owner'
    const member = this.db.get<{ role: ProjectAccess }>('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, principal.user.id])
    return member?.role ?? null
  }

  require(principal: AuthPrincipal, projectId: string, level: ProjectAccess): void {
    const access = this.accessLevel(principal, projectId)
    if (!access || ACCESS_RANK[access] < ACCESS_RANK[level]) {
      throw new ForbiddenError(`Project access '${level}' required`)
    }
  }
}
