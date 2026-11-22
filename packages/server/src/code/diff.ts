/**
 * Line-based diff (Myers O(ND)) producing unified diffs, and a unified-diff
 * patch applier with fuzzy hunk location. Used by the code editing engine,
 * code generation previews and the review engine.
 */

export type DiffOp = { op: 'equal' | 'insert' | 'delete'; line: string }

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  const max = n + m
  const v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  const offset = max + 1
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!
      else x = v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) break outer
    }
  }
  // Backtrack.
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1
    else prevK = k - 1
    const prevX = vd[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ op: 'equal', line: a[x - 1]! })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: 'insert', line: b[y - 1]! })
      else ops.push({ op: 'delete', line: a[x - 1]! })
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export interface DiffStats {
  additions: number
  deletions: number
}

export function unifiedDiff(oldText: string, newText: string, oldName = 'a', newName = 'b', context = 3): { diff: string; stats: DiffStats } {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const ops = diffLines(a, b)
  const stats = { additions: ops.filter((o) => o.op === 'insert').length, deletions: ops.filter((o) => o.op === 'delete').length }
  if (!stats.additions && !stats.deletions) return { diff: '', stats }
  const out: string[] = [`--- ${oldName}`, `+++ ${newName}`]
  // Group ops into hunks.
  let i = 0
  let aLine = 1
  let bLine = 1
  const changeIdx: number[] = []
  ops.forEach((o, idx) => o.op !== 'equal' && changeIdx.push(idx))
  const positions: Array<{ a: number; b: number }> = []
  for (const o of ops) {
    positions.push({ a: aLine, b: bLine })
    if (o.op !== 'insert') aLine++
    if (o.op !== 'delete') bLine++
  }
  while (i < changeIdx.length) {
    let start = Math.max(0, changeIdx[i]! - context)
    let end = Math.min(ops.length - 1, changeIdx[i]! + context)
    while (i + 1 < changeIdx.length && changeIdx[i + 1]! - context <= end + 1) {
      i++
      end = Math.min(ops.length - 1, changeIdx[i]! + context)
    }
    const slice = ops.slice(start, end + 1)
    const aStart = positions[start]!.a
    const bStart = positions[start]!.b
    const aCount = slice.filter((o) => o.op !== 'insert').length
    const bCount = slice.filter((o) => o.op !== 'delete').length
    out.push(`@@ -${aCount ? aStart : aStart - 1},${aCount} +${bCount ? bStart : bStart - 1},${bCount} @@`)
    for (const o of slice) out.push((o.op === 'equal' ? ' ' : o.op === 'insert' ? '+' : '-') + o.line)
    i++
    start = end
  }
  return { diff: out.join('\n') + '\n', stats }
}

export interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

export interface FilePatch {
  oldPath: string | null
  newPath: string | null
  hunks: Hunk[]
}

/** Parse a (possibly multi-file) unified diff. */
export function parsePatch(patch: string): FilePatch[] {
  const files: FilePatch[] = []
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  let current: FilePatch | null = null
  let hunk: Hunk | null = null
  const stripPrefix = (p: string) => {
    const clean = p.split('\t')[0]!.trim()
    if (clean === '/dev/null') return null
    return clean.replace(/^[ab]\//, '')
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      current = { oldPath: stripPrefix(line.slice(4)), newPath: stripPrefix(lines[i + 1]!.slice(4)), hunks: [] }
      files.push(current)
      hunk = null
      i++
      continue
    }
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (m) {
      if (!current) {
        current = { oldPath: null, newPath: null, hunks: [] }
        files.push(current)
      }
      hunk = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), lines: [] }
      current.hunks.push(hunk)
      continue
    }
    if (hunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line === '')) {
      if (line === '' && i === lines.length - 1) continue
      hunk.lines.push(line === '' ? ' ' : line)
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    }
  }
  return files
}

export class PatchError extends Error {}

/** Apply hunks to text. Locates each hunk by its context, tolerating line offsets. */
export function applyHunks(text: string, hunks: Hunk[], fuzz = 50): string {
  const lines = splitLines(text)
  const hadTrailingNewline = text.endsWith('\n') || text === ''
  let delta = 0
  for (const h of hunks) {
    const oldLines = h.lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1))
    const newLines = h.lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1))
    const expected = Math.max(0, h.oldStart - 1 + delta)
    let at = -1
    for (let off = 0; off <= fuzz && at < 0; off++) {
      for (const cand of off === 0 ? [expected] : [expected - off, expected + off]) {
        if (cand < 0 || cand + oldLines.length > lines.length) continue
        let ok = true
        for (let j = 0; j < oldLines.length; j++) if (lines[cand + j] !== oldLines[j]) { ok = false; break }
        if (ok) { at = cand; break }
      }
    }
    if (at < 0 && oldLines.length === 0) at = Math.min(expected, lines.length)
    if (at < 0) throw new PatchError(`Hunk @@ -${h.oldStart},${h.oldCount} @@ does not apply (context not found)`)
    lines.splice(at, oldLines.length, ...newLines)
    delta += newLines.length - oldLines.length
  }
  return lines.join('\n') + (lines.length && hadTrailingNewline ? '\n' : '')
}
