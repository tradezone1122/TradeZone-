/**
 * Module 16: Project Manager
 *
 * Projects are directories under the workspaces root (or imported existing
 * directories for administrators). Supports creation from templates, cloning
 * from git, membership management and archival.
 */
import { existsSync, mkdirSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { GitService } from '../git/git-service.js'
import type { AuthPrincipal } from '../auth/auth-service.js'
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js'
import type { ProjectAccess } from '../authz/rbac.js'

export interface Project {
  id: string
  name: string
  slug: string
  description: string | null
  rootPath: string
  ownerId: string
  gitRemote: string | null
  settings: ProjectSettings
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectSettings {
  testCommand?: string
  buildCommand?: string
  defaultAgent?: string
  defaultModel?: string
  deployTarget?: string
  instructions?: string
}

interface Row {
  id: string
  name: string
  slug: string
  description: string | null
  root_path: string
  owner_id: string
  git_remote: string | null
  settings: string
  archived: number
  created_at: string
  updated_at: string
}

const toProject = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  description: r.description,
  rootPath: r.root_path,
  ownerId: r.owner_id,
  gitRemote: r.git_remote,
  settings: parseJson<ProjectSettings>(r.settings, {}),
  archived: !!r.archived,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export type ProjectTemplate = 'empty' | 'node-ts' | 'python' | 'static-web'

const TEMPLATES: Record<ProjectTemplate, Record<string, string>> = {
  empty: { 'README.md': '# {{name}}\n\n{{description}}\n' },
  'node-ts': {
    'README.md': '# {{name}}\n\n{{description}}\n\n## Scripts\n\n- `npm test` — run tests\n- `npm run build` — compile TypeScript\n',
    'package.json': JSON.stringify(
      { name: '{{slug}}', version: '0.1.0', private: true, type: 'module', scripts: { build: 'tsc', test: 'node --test' }, devDependencies: {} },
      null,
      2,
    ) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist' }, include: ['src'] }, null, 2) + '\n',
    'src/index.ts': 'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n',
    'test/index.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n\ntest('sanity', () => {\n  assert.equal(1 + 1, 2)\n})\n",
    '.gitignore': 'node_modules/\ndist/\n',
  },
  python: {
    'README.md': '# {{name}}\n\n{{description}}\n\nRun tests with `python -m pytest` or `python -m unittest`.\n',
    'src/__init__.py': '',
    'src/main.py': 'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n\n\nif __name__ == "__main__":\n    print(greet("world"))\n',
    'tests/test_main.py': 'import unittest\nfrom src.main import greet\n\n\nclass TestGreet(unittest.TestCase):\n    def test_greet(self):\n        self.assertEqual(greet("a"), "Hello, a!")\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
    '.gitignore': '__pycache__/\n.venv/\n',
  },
  'static-web': {
    'README.md': '# {{name}}\n\n{{description}}\n',
    'index.html': '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>{{name}}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>{{name}}</h1>\n  <script src="main.js"></script>\n</body>\n</html>\n',
    'style.css': 'body { font-family: system-ui, sans-serif; margin: 2rem; }\n',
    'main.js': "console.log('ready')\n",
  },
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project'
}

export class ProjectService {
  constructor(
    private readonly db: Database,
    private readonly workspacesDir: string,
    private readonly git: GitService,
  ) {
    mkdirSync(workspacesDir, { recursive: true })
  }

  list(principal: AuthPrincipal, includeArchived = false): Array<Project & { access: ProjectAccess }> {
    const rows =
      principal.user.role === 'admin'
        ? this.db.all<Row & { access: string }>(`SELECT p.*, 'owner' AS access FROM projects p ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC`)
        : this.db.all<Row & { access: string }>(
            `SELECT p.*, CASE WHEN p.owner_id = ? THEN 'owner' ELSE m.role END AS access
             FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
             WHERE (p.owner_id = ? OR m.user_id IS NOT NULL) ${includeArchived ? '' : 'AND p.archived = 0'}
             ORDER BY p.updated_at DESC`,
            [principal.user.id, principal.user.id, principal.user.id],
          )
    return rows.map((r) => ({ ...toProject(r), access: r.access as ProjectAccess }))
  }

  get(id: string): Project {
    const r = this.db.get<Row>('SELECT * FROM projects WHERE id = ? OR slug = ?', [id, id])
    if (!r) throw new NotFoundError('Project')
    return toProject(r)
  }

  async create(
    ownerId: string,
    input: { name: string; description?: string; template?: ProjectTemplate; gitUrl?: string; gitBranch?: string; importPath?: string; initGit?: boolean; settings?: ProjectSettings },
    opts: { allowImport: boolean },
  ): Promise<Project> {
    const name = input.name.trim()
    if (!name) throw new ValidationError('Project name is required')
    let slug = slugify(name)
    for (let n = 2; this.db.get('SELECT id FROM projects WHERE slug = ?', [slug]); n++) slug = `${slugify(name)}-${n}`
    let root: string
    if (input.importPath) {
      if (!opts.allowImport) throw new ValidationError('Only administrators can import existing directories')
      root = path.resolve(input.importPath)
      if (!existsSync(root)) throw new ValidationError(`Directory does not exist: ${root}`)
    } else {
      root = path.join(this.workspacesDir, slug)
      if (existsSync(root)) throw new ConflictError(`Workspace directory already exists: ${slug}`)
      if (input.gitUrl) {
        await this.git.clone(input.gitUrl, root, { branch: input.gitBranch, depth: undefined })
      } else {
        mkdirSync(root, { recursive: true })
        const files = TEMPLATES[input.template ?? 'empty']
        if (!files) throw new ValidationError(`Unknown template '${input.template}'`)
        for (const [rel, content] of Object.entries(files)) {
          const full = path.join(root, rel)
          await fsp.mkdir(path.dirname(full), { recursive: true })
          await fsp.writeFile(full, content.replaceAll('{{name}}', name).replaceAll('{{slug}}', slug).replaceAll('{{description}}', input.description ?? ''))
        }
        if (input.initGit !== false) {
          try {
            await this.git.init(root)
          } catch {
            // git not installed: the project still works without version control
          }
        }
      }
    }
    const ts = now()
    const id = newId('prj')
    this.db.insert('projects', {
      id,
      name,
      slug,
      description: input.description ?? null,
      root_path: root,
      owner_id: ownerId,
      git_remote: input.gitUrl ?? null,
      settings: JSON.stringify(input.settings ?? {}),
      archived: 0,
      created_at: ts,
      updated_at: ts,
    })
    return this.get(id)
  }

  update(id: string, patch: { name?: string; description?: string | null; settings?: ProjectSettings; archived?: boolean }): Project {
    const p = this.get(id)
    const row: Record<string, unknown> = { updated_at: now() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.description !== undefined) row.description = patch.description
    if (patch.settings !== undefined) row.settings = JSON.stringify({ ...p.settings, ...patch.settings })
    if (patch.archived !== undefined) row.archived = patch.archived ? 1 : 0
    this.db.update('projects', p.id, row)
    return this.get(p.id)
  }

  touch(id: string): void {
    this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [now(), id])
  }

  async delete(id: string, deleteFiles: boolean): Promise<void> {
    const p = this.get(id)
    this.db.run('DELETE FROM projects WHERE id = ?', [p.id])
    if (deleteFiles && path.resolve(p.rootPath).startsWith(path.resolve(this.workspacesDir) + path.sep)) {
      await fsp.rm(p.rootPath, { recursive: true, force: true })
    }
  }

  members(id: string) {
    const p = this.get(id)
    return this.db.all<{ user_id: string; username: string; role: string; created_at: string }>(
      `SELECT m.user_id, u.username, m.role, m.created_at FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.created_at`,
      [p.id],
    )
  }

  setMember(id: string, userId: string, role: 'editor' | 'viewer' | null): void {
    const p = this.get(id)
    if (p.ownerId === userId) throw new ValidationError('The owner is always a member')
    if (!this.db.get('SELECT id FROM users WHERE id = ?', [userId])) throw new NotFoundError('User')
    if (role === null) this.db.run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [p.id, userId])
    else this.db.run('INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role', [p.id, userId, role, now()])
  }

  templates(): ProjectTemplate[] {
    return Object.keys(TEMPLATES) as ProjectTemplate[]
  }
}
