/**
 * Module 29: Security Engine — filesystem sandbox and command policy.
 *
 * Every file operation performed by agents, tools or the Web IDE resolves its
 * path through `resolveInside`, which rejects traversal and symlink escapes.
 * Every shell command passes through `CommandPolicy.check`.
 */
import { realpathSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'

export class SecurityError extends Error {
  readonly statusCode = 403
  constructor(message: string) {
    super(message)
    this.name = 'SecurityError'
  }
}

/**
 * Resolve `target` relative to `root`, guaranteeing the result stays inside
 * `root` even when intermediate components are symlinks.
 */
export function resolveInside(root: string, target: string): string {
  if (target.includes('\0')) throw new SecurityError('Path contains a NUL byte')
  const absRoot = path.resolve(root)
  const realRoot = existsSync(absRoot) ? realpathSync(absRoot) : absRoot
  const candidate = path.resolve(realRoot, target.replace(/^[/\\]+/, ''))
  const rel = path.relative(realRoot, candidate)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SecurityError(`Path escapes the project sandbox: ${target}`)
  }
  // Walk up to the deepest existing ancestor and verify its real path.
  let probe = candidate
  while (!existsSync(probe) && probe !== realRoot) probe = path.dirname(probe)
  const realProbe = realpathSync(probe)
  const relReal = path.relative(realRoot, realProbe)
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new SecurityError(`Path resolves outside the project sandbox via symlink: ${target}`)
  }
  return candidate
}

export function relativeTo(root: string, abs: string): string {
  const realRoot = existsSync(root) ? realpathSync(root) : path.resolve(root)
  return path.relative(realRoot, abs).split(path.sep).join('/')
}

export interface CommandCheck {
  allowed: boolean
  reason?: string
  risk: 'low' | 'medium' | 'high'
}

const DENY_RULES: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/, reason: 'Recursive deletion of root or home directory' },
  { re: /\bmkfs(\.\w+)?\b/, reason: 'Filesystem formatting' },
  { re: /\bdd\b[^|]*\bof=\/dev\//, reason: 'Raw write to a device' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'Fork bomb' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'System power control' },
  { re: />\s*\/dev\/(sd[a-z]|nvme|hd[a-z])/, reason: 'Overwriting a block device' },
  { re: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/, reason: 'Recursive permission change on root' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, reason: 'Piping a remote script into a shell' },
  { re: /\bsudo\b/, reason: 'Privilege escalation is not allowed' },
  { re: /\bnc\b.*\s-e\s/, reason: 'Reverse shell pattern' },
  { re: /\/etc\/(shadow|sudoers)/, reason: 'Access to protected system credentials' },
]

const MEDIUM_RISK = [/\brm\b/, /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)/, /\bnpm\s+publish\b/, /\bdocker\b/, /\bkill(all)?\b/, /\bchmod\b/, /\bchown\b/, />\s*[^&|]/]

export class CommandPolicy {
  constructor(private readonly opts: { allowUnsafe: boolean; extraDeny?: RegExp[] } = { allowUnsafe: false }) {}

  check(command: string): CommandCheck {
    const cmd = command.trim()
    if (!cmd) return { allowed: false, reason: 'Empty command', risk: 'low' }
    if (cmd.length > 10_000) return { allowed: false, reason: 'Command too long', risk: 'high' }
    if (!this.opts.allowUnsafe) {
      for (const rule of [...DENY_RULES, ...(this.opts.extraDeny ?? []).map((re) => ({ re, reason: 'Denied by policy' }))]) {
        if (rule.re.test(cmd)) return { allowed: false, reason: rule.reason, risk: 'high' }
      }
    }
    const risk = MEDIUM_RISK.some((re) => re.test(cmd)) ? 'medium' : 'low'
    return { allowed: true, risk }
  }
}

/** AES-256-GCM encryption for credentials stored in the database. */
export class SecretBox {
  private readonly key: Buffer
  constructor(secret: string) {
    this.key = scryptSync(secret, 'tradezone-secretbox-v1', 32)
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
  }
  decrypt(payload: string): string {
    const [version, ivB64, tagB64, dataB64] = payload.split(':')
    if (version !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) throw new Error('Unsupported secret payload')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
