/**
 * Module 25: Git Integration
 *
 * Wraps the git CLI (no shell interpolation; arguments are passed as an
 * array). Parses porcelain v2 status, logs, branches and diffs, and runs a
 * secret scan on staged changes before committing.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { runProcess, type RunResult } from '../terminal/process.js'
import { AppError, ValidationError } from '../core/errors.js'
import { scanForSecrets, type SecretFinding } from '../security/secrets.js'

export interface GitFileStatus {
  path: string
  origPath?: string
  index: string
  worktree: string
  staged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
}

export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  email: string
  date: string
  subject: string
}

export class GitError extends AppError {
  constructor(message: string, readonly result?: RunResult) {
    super(message, 400, 'git_error')
  }
}

const REF_RE = /^(?!-)[A-Za-z0-9._\/-]{1,200}$/

function assertRef(ref: string): void {
  if (!REF_RE.test(ref) || ref.includes('..')) throw new ValidationError(`Invalid git ref: ${ref}`)
}

function assertPaths(paths: string[]): void {
  for (const p of paths) if (p.startsWith('-') || p.includes('\0') || path.isAbsolute(p) || p.split('/').includes('..')) throw new ValidationError(`Invalid path: ${p}`)
}

export class GitService {
  constructor(private readonly timeoutMs = 120_000) {}

  async git(cwd: string, args: string[], opts: { allowFail?: boolean; input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    const res = await runProcess('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, timeoutMs: opts.timeoutMs ?? this.timeoutMs, input: opts.input })
    if (!opts.allowFail && res.exitCode !== 0) {
      throw new GitError(`git ${args[0]} failed: ${(res.stderr || res.stdout).trim().slice(0, 2000)}`, res)
    }
    return res
  }

  isRepo(cwd: string): boolean {
    return existsSync(path.join(cwd, '.git'))
  }

  async init(cwd: string, defaultBranch = 'main'): Promise<void> {
    await this.git(cwd, ['init', '-b', defaultBranch])
  }

  async clone(url: string, dest: string, opts: { branch?: string; depth?: number } = {}): Promise<void> {
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(url)) throw new ValidationError('Unsupported repository URL')
    const args = ['clone']
    if (opts.depth) args.push('--depth', String(opts.depth))
    if (opts.branch) {
      assertRef(opts.branch)
      args.push('--branch', opts.branch)
    }
    args.push('--', url, dest)
    await this.git(path.dirname(dest), args, { timeoutMs: 10 * 60_000 })
  }

  async status(cwd: string): Promise<GitStatus> {
    if (!this.isRepo(cwd)) return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
    const res = await this.git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
    return parsePorcelainV2(res.stdout)
  }

  async diff(cwd: string, opts: { staged?: boolean; path?: string; ref?: string; contextLines?: number } = {}): Promise<string> {
    const args = ['diff', `--unified=${opts.contextLines ?? 3}`]
    if (opts.staged) args.push('--cached')
    if (opts.ref) {
      assertRef(opts.ref)
      args.push(opts.ref)
    }
    if (opts.path) {
      assertPaths([opts.path])
      args.push('--', opts.path)
    }
    const res = await this.git(cwd, args)
    let out = res.stdout
    if (!opts.staged && !opts.ref) {
      // Include untracked files as additions so reviews see new files.
      const st = await this.status(cwd)
      for (const f of st.files.filter((x) => x.untracked && (!opts.path || x.path === opts.path)).slice(0, 50)) {
        const r = await this.git(cwd, ['diff', '--no-index', '--', '/dev/null', f.path], { allowFail: true })
        out += r.stdout
      }
    }
    return out
  }

  async log(cwd: string, limit = 50, ref?: string): Promise<GitCommit[]> {
    if (!this.isRepo(cwd)) return []
    const args = ['log', `-n`, String(Math.min(limit, 500)), '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e']
    if (ref) {
      assertRef(ref)
      args.push(ref)
    }
    const res = await this.git(cwd, args, { allowFail: true })
    if (res.exitCode !== 0) return [] // e.g. no commits yet
    return res.stdout
      .split('\x1e')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, author, email, date, subject] = line.split('\x1f')
        return { hash: hash!, shortHash: shortHash!, author: author!, email: email!, date: date!, subject: subject ?? '' }
      })
  }

  async branches(cwd: string): Promise<{ current: string | null; branches: Array<{ name: string; current: boolean; upstream: string | null; remote: boolean }> }> {
    if (!this.isRepo(cwd)) return { current: null, branches: [] }
    const res = await this.git(cwd, ['branch', '-a', '--format=%(HEAD)%1f%(refname:short)%1f%(upstream:short)'], { allowFail: true })
    const branches = res.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [head, name, upstream] = l.split('\x1f')
        return { name: name!, current: head === '*', upstream: upstream || null, remote: name!.startsWith('remotes/') || name!.includes('/') && !!name!.match(/^origin\//) }
      })
      .filter((b) => !b.name.endsWith('/HEAD'))
    return { current: branches.find((b) => b.current)?.name ?? null, branches }
  }

  async checkout(cwd: string, ref: string, create = false): Promise<void> {
    assertRef(ref)
    await this.git(cwd, create ? ['checkout', '-b', ref] : ['checkout', ref])
  }

  async stage(cwd: string, paths: string[]): Promise<void> {
    assertPaths(paths)
    await this.git(cwd, paths.length ? ['add', '--', ...paths] : ['add', '-A'])
  }

  async unstage(cwd: string, paths: string[]): Promise<void> {
    assertPaths(paths)
    const hasHead = (await this.git(cwd, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })).exitCode === 0
    if (hasHead) await this.git(cwd, ['reset', '-q', 'HEAD', '--', ...(paths.length ? paths : ['.'])])
    else await this.git(cwd, ['rm', '--cached', '-r', '-q', '--', ...(paths.length ? paths : ['.'])])
  }

  async discard(cwd: string, paths: string[]): Promise<void> {
    assertPaths(paths)
    if (!paths.length) throw new ValidationError('Specify the paths to discard')
    await this.git(cwd, ['checkout', '--', ...paths], { allowFail: true })
    await this.git(cwd, ['clean', '-f', '--', ...paths], { allowFail: true })
  }

  /** Scan staged changes for secrets. */
  async scanStaged(cwd: string): Promise<Array<SecretFinding & { file: string }>> {
    const diff = await this.git(cwd, ['diff', '--cached', '-U0'])
    const findings: Array<SecretFinding & { file: string }> = []
    let file = ''
    for (const line of diff.stdout.split('\n')) {
      if (line.startsWith('+++ b/')) file = line.slice(6)
      else if (line.startsWith('+') && !line.startsWith('+++')) {
        for (const f of scanForSecrets(line.slice(1))) findings.push({ ...f, file })
      }
    }
    return findings
  }

  async commit(cwd: string, message: string, opts: { author?: { name: string; email: string }; all?: boolean; allowSecrets?: boolean } = {}): Promise<GitCommit> {
    if (!message.trim()) throw new ValidationError('Commit message is required')
    if (opts.all) await this.stage(cwd, [])
    if (!opts.allowSecrets) {
      const secrets = await this.scanStaged(cwd)
      if (secrets.length) {
        throw new GitError(`Commit blocked: ${secrets.length} potential secret(s) in staged changes (${secrets.slice(0, 3).map((s) => `${s.file}:${s.description}`).join(', ')})`)
      }
    }
    const args: string[] = []
    const name = opts.author?.name ?? 'TradeZone Agent'
    const email = opts.author?.email ?? 'agent@tradezone.local'
    args.push('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-F', '-')
    await this.git(cwd, args, { input: message })
    return (await this.log(cwd, 1))[0]!
  }

  async push(cwd: string, remote = 'origin', branch?: string): Promise<string> {
    assertRef(remote)
    let args = ['push', remote]
    if (branch) {
      assertRef(branch)
      args = ['push', '-u', remote, branch]
    }
    const res = await this.git(cwd, args, { timeoutMs: 5 * 60_000 })
    return (res.stdout + res.stderr).trim()
  }

  async pull(cwd: string, remote = 'origin', branch?: string): Promise<string> {
    assertRef(remote)
    const args = ['pull', '--ff-only', remote]
    if (branch) {
      assertRef(branch)
      args.push(branch)
    }
    const res = await this.git(cwd, args, { timeoutMs: 5 * 60_000 })
    return (res.stdout + res.stderr).trim()
  }

  async show(cwd: string, ref: string, file: string): Promise<string> {
    assertRef(ref)
    assertPaths([file])
    return (await this.git(cwd, ['show', `${ref}:${file}`])).stdout
  }

  async remotes(cwd: string): Promise<Array<{ name: string; url: string }>> {
    if (!this.isRepo(cwd)) return []
    const res = await this.git(cwd, ['remote', '-v'], { allowFail: true })
    const seen = new Map<string, string>()
    for (const l of res.stdout.split('\n')) {
      const m = l.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
      if (m && !seen.has(m[1]!)) seen.set(m[1]!, m[2]!.replace(/\/\/[^@/]+@/, '//***@'))
    }
    return [...seen].map(([name, url]) => ({ name, url }))
  }
}

export function parsePorcelainV2(out: string): GitStatus {
  const status: GitStatus = { isRepo: true, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    if (!rec) continue
    if (rec.startsWith('# branch.head ')) status.branch = rec.slice(14) === '(detached)' ? null : rec.slice(14)
    else if (rec.startsWith('# branch.upstream ')) status.upstream = rec.slice(18)
    else if (rec.startsWith('# branch.ab ')) {
      const m = rec.match(/\+(\d+) -(\d+)/)
      if (m) {
        status.ahead = Number(m[1])
        status.behind = Number(m[2])
      }
    } else if (rec.startsWith('1 ')) {
      const parts = rec.split(' ')
      const xy = parts[1]!
      const p = parts.slice(8).join(' ')
      status.files.push(fileStatus(p, xy))
    } else if (rec.startsWith('2 ')) {
      const parts = rec.split(' ')
      const xy = parts[1]!
      const p = parts.slice(9).join(' ')
      const orig = records[++i]
      status.files.push({ ...fileStatus(p, xy), origPath: orig })
    } else if (rec.startsWith('u ')) {
      const parts = rec.split(' ')
      status.files.push({ path: parts.slice(10).join(' '), index: 'U', worktree: 'U', staged: false, untracked: false, conflicted: true })
    } else if (rec.startsWith('? ')) {
      status.files.push({ path: rec.slice(2), index: '?', worktree: '?', staged: false, untracked: true, conflicted: false })
    }
  }
  return status
}

function fileStatus(p: string, xy: string): GitFileStatus {
  const index = xy[0] ?? '.'
  const worktree = xy[1] ?? '.'
  return { path: p, index, worktree, staged: index !== '.', untracked: false, conflicted: false }
}
