/**
 * Module 24: File System Manager
 *
 * Sandboxed, project-scoped file operations used by the Web IDE, agents and
 * every engine that reads source code. All paths are resolved with
 * `resolveInside` (no traversal or symlink escape).
 */
import { promises as fsp, existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { resolveInside, relativeTo, SecurityError } from '../security/sandbox.js'
import { NotFoundError, ValidationError } from '../core/errors.js'

export const DEFAULT_IGNORES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', '__pycache__', '.venv', 'venv',
  'target', '.idea', '.vscode', '.turbo', '.parcel-cache', 'vendor', '.pytest_cache', '.mypy_cache', 'out',
])

export const MAX_READ_BYTES = 2 * 1024 * 1024

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: TreeNode[]
}

export interface FileEntry {
  path: string
  size: number
  mtimeMs: number
}

export interface SearchMatch {
  path: string
  line: number
  column: number
  text: string
}

export function isProbablyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000)
  let suspicious = 0
  for (let i = 0; i < len; i++) {
    const c = buf[i]!
    if (c === 0) return true
    if (c < 7 || (c > 13 && c < 32)) suspicious++
  }
  return len > 0 && suspicious / len > 0.3
}

export class FileSystemManager {
  resolve(root: string, rel: string): string {
    return resolveInside(root, rel || '.')
  }

  async tree(root: string, rel = '.', depth = 4, ignores: Set<string> = DEFAULT_IGNORES): Promise<TreeNode> {
    const abs = this.resolve(root, rel)
    const st = await fsp.stat(abs).catch(() => null)
    if (!st) throw new NotFoundError(`Path '${rel}'`)
    const build = async (dir: string, d: number): Promise<TreeNode[]> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      const nodes: TreeNode[] = []
      for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
        if (ignores.has(e.name) || e.name === '.DS_Store') continue
        const full = path.join(dir, e.name)
        const relPath = relativeTo(root, full)
        if (e.isDirectory()) {
          nodes.push({ name: e.name, path: relPath, type: 'dir', children: d > 1 ? await build(full, d - 1) : undefined })
        } else if (e.isFile()) {
          const s = await fsp.stat(full).catch(() => null)
          nodes.push({ name: e.name, path: relPath, type: 'file', size: s?.size })
        }
      }
      return nodes
    }
    const name = rel === '.' ? path.basename(root) : path.basename(abs)
    if (!st.isDirectory()) return { name, path: relativeTo(root, abs), type: 'file', size: st.size }
    return { name, path: relativeTo(root, abs) || '.', type: 'dir', children: await build(abs, depth) }
  }

  /** Recursively list files (relative paths), honoring ignores. */
  async listFiles(root: string, opts: { limit?: number; ignores?: Set<string>; maxSize?: number } = {}): Promise<FileEntry[]> {
    const limit = opts.limit ?? 20_000
    const ignores = opts.ignores ?? DEFAULT_IGNORES
    const out: FileEntry[] = []
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= limit) return
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (out.length >= limit) return
        if (ignores.has(e.name)) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.isFile()) {
          const s = await fsp.stat(full).catch(() => null)
          if (!s) continue
          if (opts.maxSize && s.size > opts.maxSize) continue
          out.push({ path: relativeTo(root, full), size: s.size, mtimeMs: s.mtimeMs })
        }
      }
    }
    await walk(this.resolve(root, '.'))
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async read(root: string, rel: string, opts: { maxBytes?: number } = {}): Promise<{ path: string; content: string; size: number; binary: boolean; truncated: boolean }> {
    const abs = this.resolve(root, rel)
    const st = await fsp.stat(abs).catch(() => null)
    if (!st || !st.isFile()) throw new NotFoundError(`File '${rel}'`)
    const max = opts.maxBytes ?? MAX_READ_BYTES
    const handle = await fsp.open(abs, 'r')
    try {
      const size = Math.min(st.size, max)
      const buf = Buffer.alloc(size)
      await handle.read(buf, 0, size, 0)
      const binary = isProbablyBinary(buf)
      return { path: relativeTo(root, abs), content: binary ? '' : buf.toString('utf8'), size: st.size, binary, truncated: st.size > max }
    } finally {
      await handle.close()
    }
  }

  async readText(root: string, rel: string): Promise<string> {
    const f = await this.read(root, rel)
    if (f.binary) throw new ValidationError(`File '${rel}' is binary`)
    if (f.truncated) throw new ValidationError(`File '${rel}' is larger than ${MAX_READ_BYTES} bytes`)
    return f.content
  }

  async write(root: string, rel: string, content: string, opts: { createDirs?: boolean; expectedMtimeMs?: number } = {}): Promise<{ path: string; size: number; created: boolean }> {
    const abs = this.resolve(root, rel)
    if (abs === path.resolve(root)) throw new ValidationError('Cannot write to the project root')
    const existed = existsSync(abs)
    if (existed && statSync(abs).isDirectory()) throw new ValidationError(`'${rel}' is a directory`)
    if (existed && opts.expectedMtimeMs !== undefined && Math.abs(statSync(abs).mtimeMs - opts.expectedMtimeMs) > 1) {
      throw new ValidationError(`'${rel}' was modified on disk since it was opened`)
    }
    if (opts.createDirs !== false) await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf8')
    return { path: relativeTo(root, abs), size: Buffer.byteLength(content), created: !existed }
  }

  async mkdir(root: string, rel: string): Promise<void> {
    await fsp.mkdir(this.resolve(root, rel), { recursive: true })
  }

  async rename(root: string, from: string, to: string): Promise<void> {
    const a = this.resolve(root, from)
    const b = this.resolve(root, to)
    if (!existsSync(a)) throw new NotFoundError(`Path '${from}'`)
    if (existsSync(b)) throw new ValidationError(`Target '${to}' already exists`)
    await fsp.mkdir(path.dirname(b), { recursive: true })
    await fsp.rename(a, b)
  }

  async remove(root: string, rel: string): Promise<void> {
    const abs = this.resolve(root, rel)
    if (abs === path.resolve(root) || relativeTo(root, abs) === '') throw new SecurityError('Refusing to delete the project root')
    if (!existsSync(abs)) throw new NotFoundError(`Path '${rel}'`)
    await fsp.rm(abs, { recursive: true, force: true })
  }

  async stat(root: string, rel: string) {
    const abs = this.resolve(root, rel)
    const s = await fsp.stat(abs).catch(() => null)
    if (!s) throw new NotFoundError(`Path '${rel}'`)
    return { path: relativeTo(root, abs), type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtimeMs: s.mtimeMs }
  }

  /** Glob matching supporting `**`, `*`, `?` and `{a,b}`. */
  async glob(root: string, pattern: string, limit = 2000): Promise<string[]> {
    const re = globToRegExp(pattern)
    const files = await this.listFiles(root, { limit: 50_000 })
    return files.map((f) => f.path).filter((p) => re.test(p)).slice(0, limit)
  }

  /** Regex/literal content search across text files. */
  async search(root: string, query: string, opts: { regex?: boolean; caseSensitive?: boolean; include?: string; limit?: number } = {}): Promise<SearchMatch[]> {
    if (!query) throw new ValidationError('Search query is empty')
    let re: RegExp
    try {
      re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi')
    } catch (e) {
      throw new ValidationError(`Invalid regular expression: ${(e as Error).message}`)
    }
    const include = opts.include ? globToRegExp(opts.include) : null
    const limit = opts.limit ?? 500
    const files = await this.listFiles(root, { maxSize: 1024 * 1024 })
    const out: SearchMatch[] = []
    for (const f of files) {
      if (out.length >= limit) break
      if (include && !include.test(f.path)) continue
      const abs = path.join(this.resolve(root, '.'), f.path)
      const buf = await fsp.readFile(abs).catch(() => null)
      if (!buf || isProbablyBinary(buf)) continue
      const lines = buf.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length && out.length < limit; i++) {
        re.lastIndex = 0
        const m = re.exec(lines[i]!)
        if (m) out.push({ path: f.path, line: i + 1, column: m.index + 1, text: lines[i]!.slice(0, 400) })
      }
    }
    return out
  }

  watch(root: string, onChange: (event: { type: string; path: string }) => void): FSWatcher | null {
    try {
      return watch(this.resolve(root, '.'), { recursive: true }, (type, filename) => {
        if (!filename) return
        const rel = filename.toString().split(path.sep).join('/')
        if (rel.split('/').some((seg) => DEFAULT_IGNORES.has(seg))) return
        onChange({ type, path: rel })
      })
    } catch {
      return null
    }
  }
}

export function globToRegExp(glob: string): RegExp {
  let re = ''
  let i = 0
  let inGroup = false
  while (i < glob.length) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 3 : 2
        continue
      }
      re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      re += '(?:'
      inGroup = true
    } else if (c === '}' && inGroup) {
      re += ')'
      inGroup = false
    } else if (c === ',' && inGroup) re += '|'
    else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c
    else re += c
    i++
  }
  // Patterns without a slash match at any depth ("*.ts" == "**/*.ts").
  const anchored = glob.includes('/') ? `^${re}$` : `^(?:.*/)?${re}$`
  return new RegExp(anchored)
}
