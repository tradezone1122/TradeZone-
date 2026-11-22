/**
 * Module 20: Code Editing Engine
 *
 * Deterministic, verifiable edit primitives used by agents and the IDE:
 *  - exact string replacement (must match exactly once unless replaceAll)
 *  - multi-edit (atomic: all succeed or nothing is written)
 *  - line-range replacement
 *  - unified-diff patch application (multi-file)
 *  - SEARCH/REPLACE block parsing for model-authored edits
 * Every edit returns a unified diff of what changed.
 */
import type { FileSystemManager } from '../fs/file-system.js'
import { applyHunks, parsePatch, unifiedDiff, type DiffStats } from './diff.js'
import { ValidationError } from '../core/errors.js'

export interface StringEdit {
  oldString: string
  newString: string
  replaceAll?: boolean
}

export interface EditResult {
  path: string
  diff: string
  stats: DiffStats
  created: boolean
}

export function applyStringEdits(content: string, edits: StringEdit[], fileLabel = 'file'): string {
  let out = content
  edits.forEach((e, idx) => {
    if (e.oldString === e.newString) throw new ValidationError(`Edit #${idx + 1}: oldString and newString are identical`)
    if (e.oldString === '') throw new ValidationError(`Edit #${idx + 1}: oldString must not be empty (use write_file to create files)`)
    const count = countOccurrences(out, e.oldString)
    if (count === 0) {
      const hint = closestLineHint(out, e.oldString)
      throw new ValidationError(`Edit #${idx + 1}: oldString not found in ${fileLabel}.${hint ? ` Closest match near line ${hint}.` : ''} Re-read the file and copy the text exactly.`)
    }
    if (count > 1 && !e.replaceAll) throw new ValidationError(`Edit #${idx + 1}: oldString matches ${count} times in ${fileLabel}; add surrounding context or set replaceAll.`)
    out = e.replaceAll ? out.split(e.oldString).join(e.newString) : out.replace(e.oldString, () => e.newString)
  })
  return out
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0
  let i = hay.indexOf(needle)
  while (i !== -1) {
    n++
    i = hay.indexOf(needle, i + needle.length)
  }
  return n
}

function closestLineHint(content: string, needle: string): number | null {
  const first = needle.split('\n').find((l) => l.trim().length > 3)?.trim()
  if (!first) return null
  const lines = content.split('\n')
  const idx = lines.findIndex((l) => l.trim() === first || l.includes(first.slice(0, Math.min(40, first.length))))
  return idx >= 0 ? idx + 1 : null
}

export function replaceLines(content: string, startLine: number, endLine: number, replacement: string): string {
  const lines = content.split('\n')
  if (startLine < 1 || endLine < startLine - 1 || startLine > lines.length + 1) throw new ValidationError(`Invalid line range ${startLine}-${endLine} (file has ${lines.length} lines)`)
  const repl = replacement === '' ? [] : replacement.replace(/\n$/, '').split('\n')
  lines.splice(startLine - 1, Math.max(0, endLine - startLine + 1), ...repl)
  return lines.join('\n')
}

/**
 * Parse SEARCH/REPLACE blocks:
 *   path/to/file.ts
 *   <<<<<<< SEARCH
 *   old
 *   =======
 *   new
 *   >>>>>>> REPLACE
 */
export function parseSearchReplaceBlocks(text: string): Array<{ path: string | null; search: string; replace: string }> {
  const blocks: Array<{ path: string | null; search: string; replace: string }> = []
  const re = /(?:^|\n)(?:([^\n<>=]+?)\n)?<{5,9} SEARCH\n([\s\S]*?)\n?={5,9}\n([\s\S]*?)\n?>{5,9} REPLACE/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const rawPath = m[1]?.trim().replace(/^`+|`+$/g, '').replace(/^(\*\*|#+\s*)/, '').trim()
    blocks.push({ path: rawPath && !rawPath.startsWith('```') ? rawPath : null, search: m[2] ?? '', replace: m[3] ?? '' })
  }
  return blocks
}

export class CodeEditingEngine {
  constructor(private readonly fs: FileSystemManager) {}

  async editFile(root: string, rel: string, edits: StringEdit[]): Promise<EditResult> {
    const before = await this.fs.readText(root, rel)
    const after = applyStringEdits(before, edits, rel)
    await this.fs.write(root, rel, after)
    const { diff, stats } = unifiedDiff(before, after, `a/${rel}`, `b/${rel}`)
    return { path: rel, diff, stats, created: false }
  }

  async writeFile(root: string, rel: string, content: string): Promise<EditResult> {
    let before = ''
    let existed = true
    try {
      before = await this.fs.readText(root, rel)
    } catch {
      existed = false
    }
    await this.fs.write(root, rel, content)
    const { diff, stats } = unifiedDiff(before, content, existed ? `a/${rel}` : '/dev/null', `b/${rel}`)
    return { path: rel, diff, stats, created: !existed }
  }

  async replaceLineRange(root: string, rel: string, start: number, end: number, replacement: string): Promise<EditResult> {
    const before = await this.fs.readText(root, rel)
    const after = replaceLines(before, start, end, replacement)
    await this.fs.write(root, rel, after)
    const { diff, stats } = unifiedDiff(before, after, `a/${rel}`, `b/${rel}`)
    return { path: rel, diff, stats, created: false }
  }

  /** Apply a unified diff. Validates every file first, then writes (atomic per call). */
  async applyPatch(root: string, patch: string): Promise<EditResult[]> {
    const files = parsePatch(patch)
    if (!files.length) throw new ValidationError('Patch contains no file changes')
    const planned: Array<{ rel: string; before: string; after: string | null; created: boolean }> = []
    for (const f of files) {
      const rel = f.newPath ?? f.oldPath
      if (!rel) throw new ValidationError('Patch entry without a file path')
      if (f.newPath === null) {
        planned.push({ rel: f.oldPath!, before: await this.fs.readText(root, f.oldPath!), after: null, created: false })
        continue
      }
      let before = ''
      let created = false
      if (f.oldPath === null) created = true
      else before = await this.fs.readText(root, f.oldPath)
      planned.push({ rel, before, after: applyHunks(before, f.hunks), created })
    }
    const results: EditResult[] = []
    for (const p of planned) {
      if (p.after === null) {
        await this.fs.remove(root, p.rel)
        const { diff, stats } = unifiedDiff(p.before, '', `a/${p.rel}`, '/dev/null')
        results.push({ path: p.rel, diff, stats, created: false })
      } else {
        await this.fs.write(root, p.rel, p.after)
        const { diff, stats } = unifiedDiff(p.before, p.after, p.created ? '/dev/null' : `a/${p.rel}`, `b/${p.rel}`)
        results.push({ path: p.rel, diff, stats, created: p.created })
      }
    }
    return results
  }

  /** Apply SEARCH/REPLACE blocks authored by a model. `defaultPath` is used for blocks without a path. */
  async applySearchReplace(root: string, text: string, defaultPath?: string): Promise<EditResult[]> {
    const blocks = parseSearchReplaceBlocks(text)
    if (!blocks.length) throw new ValidationError('No SEARCH/REPLACE blocks found')
    const byFile = new Map<string, StringEdit[]>()
    const creates = new Map<string, string>()
    for (const b of blocks) {
      const rel = b.path ?? defaultPath
      if (!rel) throw new ValidationError('SEARCH/REPLACE block without a file path')
      if (b.search.trim() === '') creates.set(rel, b.replace.endsWith('\n') ? b.replace : b.replace + '\n')
      else byFile.set(rel, [...(byFile.get(rel) ?? []), { oldString: b.search, newString: b.replace }])
    }
    // Validate all edits before writing anything.
    const planned: Array<{ rel: string; before: string; after: string }> = []
    for (const [rel, edits] of byFile) {
      const before = await this.fs.readText(root, rel)
      planned.push({ rel, before, after: applyStringEdits(before, edits, rel) })
    }
    const results: EditResult[] = []
    for (const p of planned) {
      await this.fs.write(root, p.rel, p.after)
      const { diff, stats } = unifiedDiff(p.before, p.after, `a/${p.rel}`, `b/${p.rel}`)
      results.push({ path: p.rel, diff, stats, created: false })
    }
    for (const [rel, content] of creates) results.push(await this.writeFile(root, rel, content))
    return results
  }
}
