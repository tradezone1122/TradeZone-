/**
 * Shared process runner used by the command tool, testing engine, git
 * integration and deployment system. Enforces timeouts, output limits,
 * cancellation, and the security command policy.
 */
import { spawn } from 'node:child_process'
import type { CommandPolicy } from '../security/sandbox.js'
import { SecurityError } from '../security/sandbox.js'

export interface RunResult {
  command: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface RunOptions {
  cwd: string
  timeoutMs?: number
  env?: Record<string, string>
  signal?: AbortSignal
  maxOutput?: number
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
  input?: string
}

const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'SHELL', 'NODE_ENV', 'GOPATH', 'GOCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'JAVA_HOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'NVM_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']

/** Environment for child processes: platform secrets are not inherited. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of SAFE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k]!
  env.CI = env.CI ?? '1'
  env.FORCE_COLOR = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  return { ...env, ...extra }
}

/** Run a shell command (bash -lc) with policy checks. */
export function runShell(command: string, opts: RunOptions, policy?: CommandPolicy): Promise<RunResult> {
  if (policy) {
    const check = policy.check(command)
    if (!check.allowed) return Promise.reject(new SecurityError(`Command blocked by security policy: ${check.reason}`))
  }
  return runProcess('bash', ['-c', command], opts, command)
}

/** Run an executable directly (no shell). */
export function runProcess(file: string, args: string[], opts: RunOptions, label?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const max = opts.maxOutput ?? 1_000_000
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: childEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    } catch (e) {
      reject(e)
      return
    }
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs ?? 120_000)
    const onAbort = () => kill()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      if (stdout.length < max) stdout += s
      opts.onOutput?.(s, 'stdout')
    })
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      if (stderr.length < max) stderr += s
      opts.onOutput?.(s, 'stderr')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ command: label ?? [file, ...args].join(' '), exitCode: code, signal, stdout: stdout.slice(0, max), stderr: stderr.slice(0, max), durationMs: Date.now() - started, timedOut })
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

export function formatRunResult(r: RunResult): string {
  const parts = [`$ ${r.command}`, `exit code: ${r.exitCode ?? 'none'}${r.signal ? ` (signal ${r.signal})` : ''}${r.timedOut ? ' — TIMED OUT' : ''} — ${r.durationMs} ms`]
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`)
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`)
  return parts.join('\n')
}
