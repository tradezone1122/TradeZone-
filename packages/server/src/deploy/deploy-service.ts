/**
 * Module 40: Deployment System (project deployments)
 *
 * Deploys a project with one of three targets:
 *  - "static": runs the build command, copies the output directory into the
 *    platform's deployments folder and serves it at /deployments/<id>/;
 *  - "docker": builds a Docker image from the project's Dockerfile;
 *  - "script": runs a deploy command configured in project settings.
 * Every deployment is recorded with its streamed log. (Deployment of the
 * platform itself is covered by the Dockerfile, compose file, Kubernetes
 * manifests and install scripts in the repository.)
 */
import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import type { Database } from '../db/database.js'
import { newId, now } from '../db/database.js'
import type { EventBus } from '../events/bus.js'
import { runShell, runProcess } from '../terminal/process.js'
import type { CommandPolicy } from '../security/sandbox.js'
import { resolveInside } from '../security/sandbox.js'
import { NotFoundError, ValidationError } from '../core/errors.js'

export type DeployTarget = 'static' | 'docker' | 'script'

export interface Deployment {
  id: string
  projectId: string
  target: DeployTarget
  status: 'running' | 'succeeded' | 'failed'
  log: string
  artifact: string | null
  createdBy: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface DeployOptions {
  target: DeployTarget
  buildCommand?: string
  outputDir?: string
  imageTag?: string
  command?: string
  userId?: string
}

export class DeployService {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly policy: CommandPolicy,
    readonly deploymentsDir: string,
  ) {}

  list(projectId: string): Deployment[] {
    return this.db.all<any>('SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT 50', [projectId]).map(this.map)
  }

  get(id: string): Deployment {
    const r = this.db.get<any>('SELECT * FROM deployments WHERE id = ?', [id])
    if (!r) throw new NotFoundError('Deployment')
    return this.map(r)
  }

  private map = (r: any): Deployment => ({ id: r.id, projectId: r.project_id, target: r.target, status: r.status, log: r.log ?? '', artifact: r.artifact, createdBy: r.created_by, startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at })

  async deploy(project: { id: string; rootPath: string; slug: string }, opts: DeployOptions): Promise<Deployment> {
    const id = newId('dep')
    this.db.insert('deployments', { id, project_id: project.id, target: opts.target, status: 'running', log: '', artifact: null, created_by: opts.userId ?? null, started_at: now(), created_at: now() })
    let log = ''
    const append = (s: string) => {
      log += s
      this.bus.publish(`project:${project.id}`, 'deploy.output', { deploymentId: id, chunk: s })
    }
    const fail = (msg: string) => {
      append(`\n✖ ${msg}\n`)
      this.db.update('deployments', id, { status: 'failed', log: log.slice(-500_000), finished_at: now() })
      this.bus.publish(`project:${project.id}`, 'deploy.finished', { deploymentId: id, status: 'failed' })
      return this.get(id)
    }
    try {
      if (opts.target === 'static') {
        if (opts.buildCommand) {
          append(`$ ${opts.buildCommand}\n`)
          const r = await runShell(opts.buildCommand, { cwd: project.rootPath, timeoutMs: 15 * 60_000, onOutput: append }, this.policy)
          if (r.exitCode !== 0) return fail(`Build failed with exit code ${r.exitCode}`)
        }
        const outRel = opts.outputDir ?? (['dist', 'build', 'out', 'public'].find((d) => existsSync(path.join(project.rootPath, d))) ?? '.')
        const src = resolveInside(project.rootPath, outRel)
        if (!existsSync(path.join(src, 'index.html'))) return fail(`No index.html in output directory '${outRel}'`)
        const dest = path.join(this.deploymentsDir, id)
        await fsp.mkdir(this.deploymentsDir, { recursive: true })
        await fsp.cp(src, dest, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) && !p.includes(`${path.sep}node_modules`) })
        append(`Copied ${outRel}/ to deployment ${id}\nServed at /deployments/${id}/\n`)
        this.db.update('deployments', id, { artifact: `/deployments/${id}/` })
      } else if (opts.target === 'docker') {
        if (!existsSync(path.join(project.rootPath, 'Dockerfile'))) return fail('Project has no Dockerfile')
        const tag = opts.imageTag ?? `tradezone/${project.slug}:${Date.now()}`
        if (!/^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/.test(tag)) throw new ValidationError('Invalid image tag')
        append(`$ docker build -t ${tag} .\n`)
        const r = await runProcess('docker', ['build', '-t', tag, '.'], { cwd: project.rootPath, timeoutMs: 30 * 60_000, onOutput: append }).catch((e: Error) => ({ exitCode: -1, stderr: e.message }) as any)
        if (r.exitCode !== 0) return fail(r.exitCode === -1 ? `Docker is not available: ${r.stderr}` : `docker build failed (exit ${r.exitCode})`)
        this.db.update('deployments', id, { artifact: tag })
      } else {
        if (!opts.command) throw new ValidationError('A deploy command is required for the script target')
        append(`$ ${opts.command}\n`)
        const r = await runShell(opts.command, { cwd: project.rootPath, timeoutMs: 30 * 60_000, onOutput: append }, this.policy)
        if (r.exitCode !== 0) return fail(`Deploy command failed with exit code ${r.exitCode}`)
      }
      append('\n✔ Deployment succeeded\n')
      this.db.update('deployments', id, { status: 'succeeded', log: log.slice(-500_000), finished_at: now() })
      this.bus.publish(`project:${project.id}`, 'deploy.finished', { deploymentId: id, status: 'succeeded' })
      return this.get(id)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
}
