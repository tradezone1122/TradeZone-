import { z } from 'zod'
import type { Api, RouteContext } from '../http.js'
import { IdParams } from '../http.js'
import type { ProjectAccess } from '../../authz/rbac.js'
import type { Project } from '../../projects/project-service.js'
import { DebuggingEngine } from '../../debugging/debug-engine.js'
import { detectTestCommand } from '../../testing/test-engine.js'

function project(ctx: RouteContext<any, any, { id: string }>, level: ProjectAccess): Project {
  const p = ctx.services.projects.get(ctx.params.id)
  ctx.services.projectAccess.require(ctx.principal, p.id, level)
  return p
}

const PathQuery = z.object({ path: z.string().default('.') })
const Settings = z.object({ testCommand: z.string().optional(), buildCommand: z.string().optional(), defaultAgent: z.string().optional(), defaultModel: z.string().optional(), deployTarget: z.string().optional(), instructions: z.string().max(20_000).optional() })

export function projectRoutes(api: Api): void {
  const s = api.services

  // ------------------------------------------------------------ projects
  api.get('/api/projects', { perm: 'projects:read', query: z.object({ archived: z.coerce.boolean().optional() }) }, ({ principal, query }) => s.projects.list(principal, query.archived))
  api.get('/api/projects/templates', { perm: 'projects:read' }, () => s.projects.templates())
  api.post(
    '/api/projects',
    {
      perm: 'projects:write',
      audit: 'project.create',
      body: z.object({ name: z.string().min(1).max(100), description: z.string().max(2000).optional(), template: z.enum(['empty', 'node-ts', 'python', 'static-web']).optional(), gitUrl: z.string().optional(), gitBranch: z.string().optional(), importPath: z.string().optional(), initGit: z.boolean().optional(), settings: Settings.optional() }),
    },
    ({ principal, body }) => s.projects.create(principal.user.id, body, { allowImport: principal.user.role === 'admin' }),
  )
  api.get('/api/projects/:id', { perm: 'projects:read', params: IdParams }, (ctx) => {
    const p = project(ctx, 'viewer')
    return { ...p, access: ctx.services.projectAccess.accessLevel(ctx.principal, p.id), members: s.projects.members(p.id) }
  })
  api.patch('/api/projects/:id', { perm: 'projects:write', audit: 'project.update', params: IdParams, body: z.object({ name: z.string().min(1).max(100).optional(), description: z.string().max(2000).nullish(), settings: Settings.optional(), archived: z.boolean().optional() }) }, (ctx) => {
    const p = project(ctx, 'editor')
    return s.projects.update(p.id, ctx.body)
  })
  api.delete('/api/projects/:id', { perm: 'projects:delete', audit: 'project.delete', params: IdParams, query: z.object({ deleteFiles: z.coerce.boolean().optional() }) }, async (ctx) => {
    const p = project(ctx, 'owner')
    await s.projects.delete(p.id, !!ctx.query.deleteFiles)
  })
  api.put('/api/projects/:id/members/:userId', { perm: 'projects:write', audit: 'project.member', params: z.object({ id: z.string(), userId: z.string() }), body: z.object({ role: z.enum(['editor', 'viewer']).nullable() }) }, (ctx) => {
    const p = project(ctx, 'owner')
    s.projects.setMember(p.id, ctx.params.userId, ctx.body.role)
    return s.projects.members(p.id)
  })

  // --------------------------------------------------------------- files
  api.get('/api/projects/:id/tree', { perm: 'files:read', params: IdParams, query: z.object({ path: z.string().default('.'), depth: z.coerce.number().int().min(1).max(8).default(3) }) }, (ctx) => s.fs.tree(project(ctx, 'viewer').rootPath, ctx.query.path, ctx.query.depth))
  api.get('/api/projects/:id/files', { perm: 'files:read', params: IdParams, query: z.object({ path: z.string().min(1) }) }, async (ctx) => {
    const p = project(ctx, 'viewer')
    const f = await s.fs.read(p.rootPath, ctx.query.path)
    const st = await s.fs.stat(p.rootPath, ctx.query.path)
    return { ...f, mtimeMs: st.mtimeMs }
  })
  api.put('/api/projects/:id/files', { perm: 'files:write', params: IdParams, body: z.object({ path: z.string().min(1), content: z.string(), expectedMtimeMs: z.number().optional() }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    const r = await s.fs.write(p.rootPath, ctx.body.path, ctx.body.content, { expectedMtimeMs: ctx.body.expectedMtimeMs })
    s.bus.publish(`project:${p.id}`, 'file.changed', { path: r.path, by: ctx.principal.user.username })
    s.projects.touch(p.id)
    return { ...r, mtimeMs: (await s.fs.stat(p.rootPath, r.path)).mtimeMs }
  })
  api.post('/api/projects/:id/files/mkdir', { perm: 'files:write', params: IdParams, body: z.object({ path: z.string().min(1) }) }, async (ctx) => {
    await s.fs.mkdir(project(ctx, 'editor').rootPath, ctx.body.path)
    return { ok: true }
  })
  api.post('/api/projects/:id/files/rename', { perm: 'files:write', params: IdParams, body: z.object({ from: z.string().min(1), to: z.string().min(1) }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    await s.fs.rename(p.rootPath, ctx.body.from, ctx.body.to)
    s.bus.publish(`project:${p.id}`, 'file.changed', { path: ctx.body.to, from: ctx.body.from })
    return { ok: true }
  })
  api.delete('/api/projects/:id/files', { perm: 'files:write', params: IdParams, query: z.object({ path: z.string().min(1) }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    await s.fs.remove(p.rootPath, ctx.query.path)
    s.bus.publish(`project:${p.id}`, 'file.changed', { path: ctx.query.path, deleted: true })
  })
  api.get('/api/projects/:id/search', { perm: 'files:read', params: IdParams, query: z.object({ q: z.string().min(1), regex: z.coerce.boolean().optional(), caseSensitive: z.coerce.boolean().optional(), include: z.string().optional(), limit: z.coerce.number().int().max(2000).optional() }) }, (ctx) =>
    s.fs.search(project(ctx, 'viewer').rootPath, ctx.query.q, { regex: ctx.query.regex, caseSensitive: ctx.query.caseSensitive, include: ctx.query.include, limit: ctx.query.limit }),
  )
  api.get('/api/projects/:id/glob', { perm: 'files:read', params: IdParams, query: z.object({ pattern: z.string().min(1) }) }, (ctx) => s.fs.glob(project(ctx, 'viewer').rootPath, ctx.query.pattern))

  // ----------------------------------------------------------------- git
  api.get('/api/projects/:id/git/status', { perm: 'git:read', params: IdParams }, (ctx) => s.git.status(project(ctx, 'viewer').rootPath))
  api.get('/api/projects/:id/git/diff', { perm: 'git:read', params: IdParams, query: z.object({ staged: z.coerce.boolean().optional(), path: z.string().optional(), ref: z.string().optional() }) }, async (ctx) => ({ diff: await s.git.diff(project(ctx, 'viewer').rootPath, ctx.query) }))
  api.get('/api/projects/:id/git/log', { perm: 'git:read', params: IdParams, query: z.object({ limit: z.coerce.number().int().max(500).optional(), ref: z.string().optional() }) }, (ctx) => s.git.log(project(ctx, 'viewer').rootPath, ctx.query.limit, ctx.query.ref))
  api.get('/api/projects/:id/git/branches', { perm: 'git:read', params: IdParams }, (ctx) => s.git.branches(project(ctx, 'viewer').rootPath))
  api.get('/api/projects/:id/git/remotes', { perm: 'git:read', params: IdParams }, (ctx) => s.git.remotes(project(ctx, 'viewer').rootPath))
  api.get('/api/projects/:id/git/show', { perm: 'git:read', params: IdParams, query: z.object({ ref: z.string(), path: z.string() }) }, async (ctx) => ({ content: await s.git.show(project(ctx, 'viewer').rootPath, ctx.query.ref, ctx.query.path) }))
  api.post('/api/projects/:id/git/init', { perm: 'git:write', params: IdParams }, async (ctx) => {
    const p = project(ctx, 'editor')
    await s.git.init(p.rootPath)
    return s.git.status(p.rootPath)
  })
  api.post('/api/projects/:id/git/checkout', { perm: 'git:write', audit: 'git.checkout', params: IdParams, body: z.object({ ref: z.string(), create: z.boolean().optional() }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    await s.git.checkout(p.rootPath, ctx.body.ref, ctx.body.create)
    s.bus.publish(`project:${p.id}`, 'git.changed', {})
    return s.git.status(p.rootPath)
  })
  api.post('/api/projects/:id/git/stage', { perm: 'git:write', params: IdParams, body: z.object({ paths: z.array(z.string()) }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    await s.git.stage(p.rootPath, ctx.body.paths)
    return s.git.status(p.rootPath)
  })
  api.post('/api/projects/:id/git/unstage', { perm: 'git:write', params: IdParams, body: z.object({ paths: z.array(z.string()) }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    await s.git.unstage(p.rootPath, ctx.body.paths)
    return s.git.status(p.rootPath)
  })
  api.post('/api/projects/:id/git/discard', { perm: 'git:write', audit: 'git.discard', params: IdParams, body: z.object({ paths: z.array(z.string()).min(1) }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    await s.git.discard(p.rootPath, ctx.body.paths)
    s.bus.publish(`project:${p.id}`, 'file.changed', { paths: ctx.body.paths })
    return s.git.status(p.rootPath)
  })
  api.post('/api/projects/:id/git/commit', { perm: 'git:write', audit: 'git.commit', params: IdParams, body: z.object({ message: z.string().min(1), all: z.boolean().optional(), allowSecrets: z.boolean().optional() }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    const u = ctx.principal.user
    const c = await s.git.commit(p.rootPath, ctx.body.message, { all: ctx.body.all, allowSecrets: ctx.body.allowSecrets && u.role === 'admin', author: { name: u.displayName ?? u.username, email: u.email ?? `${u.username}@tradezone.local` } })
    s.bus.publish(`project:${p.id}`, 'git.changed', { commit: c.shortHash })
    return c
  })
  api.post('/api/projects/:id/git/push', { perm: 'git:write', audit: 'git.push', params: IdParams, body: z.object({ remote: z.string().optional(), branch: z.string().optional() }) }, async (ctx) => ({ output: await s.git.push(project(ctx, 'editor').rootPath, ctx.body.remote, ctx.body.branch) }))
  api.post('/api/projects/:id/git/pull', { perm: 'git:write', audit: 'git.pull', params: IdParams, body: z.object({ remote: z.string().optional(), branch: z.string().optional() }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    const output = await s.git.pull(p.rootPath, ctx.body.remote, ctx.body.branch)
    s.bus.publish(`project:${p.id}`, 'file.changed', {})
    return { output }
  })

  // ----------------------------------------------------- code intelligence
  api.get('/api/projects/:id/analysis', { perm: 'projects:read', params: IdParams }, (ctx) => {
    const p = project(ctx, 'viewer')
    return s.repo.analyze(p.rootPath, s.symbolIndex(p.rootPath))
  })
  api.get('/api/projects/:id/symbols', { perm: 'files:read', params: IdParams, query: z.object({ q: z.string().default(''), kind: z.string().optional(), limit: z.coerce.number().int().max(500).optional() }) }, async (ctx) => {
    const p = project(ctx, 'viewer')
    const idx = s.symbolIndex(p.rootPath)
    await idx.refresh()
    return ctx.query.q ? idx.search(ctx.query.q, { kind: ctx.query.kind as never, limit: ctx.query.limit }) : idx.allSymbols().slice(0, ctx.query.limit ?? 200)
  })
  api.get('/api/projects/:id/outline', { perm: 'files:read', params: IdParams, query: z.object({ path: z.string().min(1) }) }, async (ctx) => {
    const { analyzeSource } = await import('../../code/symbols.js')
    const p = project(ctx, 'viewer')
    return analyzeSource(ctx.query.path, await s.fs.readText(p.rootPath, ctx.query.path))
  })

  // --------------------------------------------------------- code editing
  api.post('/api/projects/:id/edit', { perm: 'files:write', params: IdParams, body: z.object({ path: z.string(), edits: z.array(z.object({ oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().optional() })).min(1) }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    const r = await s.editing.editFile(p.rootPath, ctx.body.path, ctx.body.edits)
    s.bus.publish(`project:${p.id}`, 'file.changed', { path: r.path })
    return r
  })
  api.post('/api/projects/:id/patch', { perm: 'files:write', params: IdParams, body: z.object({ patch: z.string().min(1) }) }, async (ctx) => {
    const p = project(ctx, 'editor')
    const r = await s.editing.applyPatch(p.rootPath, ctx.body.patch)
    for (const e of r) s.bus.publish(`project:${p.id}`, 'file.changed', { path: e.path })
    return r
  })
  api.post('/api/projects/:id/generate/file', { perm: 'agents:run', params: IdParams, body: z.object({ path: z.string().min(1), instructions: z.string().min(3), model: z.string().optional(), write: z.boolean().optional() }) }, async (ctx) => {
    const p = project(ctx, ctx.body.write ? 'editor' : 'viewer')
    return s.codegen.generateFile(p.rootPath, { ...ctx.body, userId: ctx.principal.user.id })
  })
  api.post('/api/projects/:id/generate/tests', { perm: 'agents:run', params: IdParams, body: z.object({ source: z.string().min(1), testPath: z.string().optional(), framework: z.string().optional(), model: z.string().optional(), write: z.boolean().optional() }) }, async (ctx) => {
    const p = project(ctx, ctx.body.write ? 'editor' : 'viewer')
    return s.codegen.generateTests(p.rootPath, { ...ctx.body, userId: ctx.principal.user.id })
  })
  api.post('/api/projects/:id/generate/edit', { perm: 'agents:run', params: IdParams, body: z.object({ path: z.string().min(1), instruction: z.string().min(3), model: z.string().optional(), write: z.boolean().optional() }) }, async (ctx) => {
    const p = project(ctx, ctx.body.write ? 'editor' : 'viewer')
    return s.codegen.aiEdit(p.rootPath, { ...ctx.body, userId: ctx.principal.user.id })
  })

  // ------------------------------------------------------------- testing
  api.get('/api/projects/:id/tests/detect', { perm: 'projects:read', params: IdParams }, (ctx) => detectTestCommand(project(ctx, 'viewer').rootPath))
  api.post('/api/projects/:id/tests/run', { perm: 'tests:run', audit: 'tests.run', params: IdParams, body: z.object({ command: z.string().optional(), filter: z.string().optional() }) }, (ctx) => {
    const p = project(ctx, 'editor')
    return s.testing.run(p.id, p.rootPath, { command: ctx.body.command ?? p.settings.testCommand, filter: ctx.body.filter })
  })
  api.get('/api/projects/:id/tests', { perm: 'projects:read', params: IdParams }, (ctx) => s.testing.history(project(ctx, 'viewer').id))
  api.get('/api/projects/:id/tests/:runId', { perm: 'projects:read', params: z.object({ id: z.string(), runId: z.string() }) }, (ctx) => {
    project(ctx, 'viewer')
    return s.testing.get(ctx.params.runId)
  })

  // ----------------------------------------------------------- debugging
  api.post('/api/projects/:id/debug/analyze', { perm: 'files:read', params: IdParams, body: z.object({ output: z.string().min(1) }) }, async (ctx) => {
    const contexts = await s.debugging.buildContext(project(ctx, 'viewer').rootPath, ctx.body.output)
    return { contexts, formatted: DebuggingEngine.formatContexts(contexts) }
  })
  api.post('/api/projects/:id/debug/reproduce', { perm: 'terminal:use', audit: 'debug.reproduce', params: IdParams, body: z.object({ command: z.string().min(1), timeoutSeconds: z.number().int().max(1800).optional() }) }, (ctx) =>
    s.debugging.reproduce(project(ctx, 'editor').rootPath, ctx.body.command, (ctx.body.timeoutSeconds ?? 120) * 1000),
  )

  // -------------------------------------------------------------- review
  api.post('/api/projects/:id/review', { perm: 'review:run', params: IdParams, body: z.object({ target: z.enum(['diff', 'staged', 'files']).optional(), files: z.array(z.string()).optional(), ai: z.boolean().optional(), model: z.string().optional() }) }, (ctx) => {
    const p = project(ctx, 'viewer')
    return s.review.review(p.id, p.rootPath, { ...ctx.body, userId: ctx.principal.user.id })
  })
  api.get('/api/projects/:id/reviews', { perm: 'projects:read', params: IdParams }, (ctx) => s.review.history(project(ctx, 'viewer').id))
  api.get('/api/projects/:id/reviews/:reviewId', { perm: 'projects:read', params: z.object({ id: z.string(), reviewId: z.string() }) }, (ctx) => {
    project(ctx, 'viewer')
    return s.review.get(ctx.params.reviewId)
  })

  // ---------------------------------------------------------- deployment
  api.post('/api/projects/:id/deploy', { perm: 'deploy:run', audit: 'deploy.run', params: IdParams, body: z.object({ target: z.enum(['static', 'docker', 'script']), buildCommand: z.string().optional(), outputDir: z.string().optional(), imageTag: z.string().optional(), command: z.string().optional() }) }, (ctx) => {
    const p = project(ctx, 'editor')
    return s.deploy.deploy({ id: p.id, rootPath: p.rootPath, slug: p.slug }, { ...ctx.body, buildCommand: ctx.body.buildCommand ?? p.settings.buildCommand, userId: ctx.principal.user.id })
  })
  api.get('/api/projects/:id/deployments', { perm: 'projects:read', params: IdParams }, (ctx) => s.deploy.list(project(ctx, 'viewer').id))

  // ------------------------------------------------------------ terminals
  api.get('/api/terminals', { perm: 'terminal:use' }, ({ principal }) => s.terminals.list(principal.user.id, principal.user.role === 'admin'))
  api.post('/api/projects/:id/terminals', { perm: 'terminal:use', audit: 'terminal.open', params: IdParams, body: z.object({ cols: z.number().int().optional(), rows: z.number().int().optional() }) }, (ctx) => {
    const p = project(ctx, 'editor')
    return s.terminals.create(ctx.principal.user.id, p.rootPath, { projectId: p.id, cols: ctx.body.cols, rows: ctx.body.rows })
  })
  api.delete('/api/terminals/:id', { perm: 'terminal:use', params: IdParams }, ({ params, principal }) => {
    s.terminals.kill(params.id, principal.user.id, principal.user.role === 'admin')
  })
  api.get('/api/terminals/:id/scrollback', { perm: 'terminal:use', params: IdParams }, ({ params, principal }) => ({ data: s.terminals.scrollback(params.id, principal.user.id, principal.user.role === 'admin') }))
  api.post('/api/terminals/:id/input', { perm: 'terminal:use', params: IdParams, body: z.object({ data: z.string().max(100_000) }) }, ({ params, principal, body }) => {
    s.terminals.write(params.id, principal.user.id, principal.user.role === 'admin', body.data)
    return { ok: true }
  })

  void PathQuery
}
