/**
 * Module 28: Code Review Engine
 *
 * Two layers:
 *  1. Static analysis on changed or selected files: secrets, debug leftovers,
 *     dangerous APIs (eval, exec, innerHTML, SQL concatenation, shell=True),
 *     TODO/FIXME, oversize files and functions, missing tests for new source.
 *  2. Optional AI review through the AI router with a strict JSON contract,
 *     merged with the static findings into a scored report.
 */
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import type { FileSystemManager } from '../fs/file-system.js'
import type { GitService } from '../git/git-service.js'
import type { AIRouter } from '../router/ai-router.js'
import { scanForSecrets } from '../security/secrets.js'
import { analyzeSource, languageOf } from '../code/symbols.js'
import { parsePatch } from '../code/diff.js'
import { textOf } from '../core/types.js'
import { extractJson } from '../planning/json.js'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface ReviewFinding {
  file: string
  line?: number
  severity: Severity
  category: string
  rule: string
  message: string
  suggestion?: string
  source: 'static' | 'ai'
}

export interface ReviewReport {
  id: string
  projectId: string
  target: string
  summary: string
  score: number
  findings: ReviewFinding[]
  aiUsed: boolean
  createdAt: string
}

interface Rule {
  id: string
  category: string
  severity: Severity
  re: RegExp
  languages?: string[]
  message: string
  suggestion?: string
}

const RULES: Rule[] = [
  { id: 'no-eval', category: 'security', severity: 'high', re: /\beval\s*\(|new Function\s*\(/, languages: ['javascript', 'typescript'], message: 'Dynamic code evaluation (eval/new Function)', suggestion: 'Avoid evaluating strings as code; parse data explicitly.' },
  { id: 'inner-html', category: 'security', severity: 'medium', re: /\.innerHTML\s*=|dangerouslySetInnerHTML/, languages: ['javascript', 'typescript'], message: 'Raw HTML injection can cause XSS', suggestion: 'Use textContent or sanitize the HTML.' },
  { id: 'child-process-exec', category: 'security', severity: 'medium', re: /\bexec(Sync)?\s*\(\s*[`'"].*\$\{|\bexec(Sync)?\s*\([^)]*\+/, languages: ['javascript', 'typescript'], message: 'Shell command built from interpolated input', suggestion: 'Use execFile/spawn with an argument array.' },
  { id: 'sql-concat', category: 'security', severity: 'high', re: /(SELECT|INSERT|UPDATE|DELETE)\s[^;]*["'`]\s*\+\s*\w|(SELECT|INSERT|UPDATE|DELETE)\s[^;]*\$\{/i, message: 'SQL query built by string concatenation', suggestion: 'Use parameterized queries.' },
  { id: 'py-shell-true', category: 'security', severity: 'high', re: /subprocess\.\w+\([^)]*shell\s*=\s*True/, languages: ['python'], message: 'subprocess with shell=True', suggestion: 'Pass an argument list and shell=False.' },
  { id: 'py-eval', category: 'security', severity: 'high', re: /\b(eval|exec)\s*\(/, languages: ['python'], message: 'eval/exec on dynamic input', suggestion: 'Use ast.literal_eval or explicit parsing.' },
  { id: 'pickle-load', category: 'security', severity: 'medium', re: /pickle\.loads?\(/, languages: ['python'], message: 'Unpickling untrusted data is unsafe' },
  { id: 'weak-hash', category: 'security', severity: 'medium', re: /\b(md5|sha1)\b\s*\(|createHash\(['"](md5|sha1)['"]\)/i, message: 'Weak hash algorithm', suggestion: 'Use SHA-256 or a password hash (scrypt/argon2) where appropriate.' },
  { id: 'insecure-http', category: 'security', severity: 'low', re: /["']http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^"']+["']/, message: 'Plain HTTP URL', suggestion: 'Use HTTPS.' },
  { id: 'tls-disabled', category: 'security', severity: 'high', re: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED/, message: 'TLS certificate verification disabled' },
  { id: 'console-log', category: 'quality', severity: 'low', re: /\bconsole\.(log|debug)\(/, languages: ['javascript', 'typescript'], message: 'Leftover console logging' },
  { id: 'debugger', category: 'quality', severity: 'medium', re: /^\s*debugger;?\s*$/, languages: ['javascript', 'typescript'], message: 'debugger statement' },
  { id: 'py-print-debug', category: 'quality', severity: 'info', re: /^\s*(breakpoint\(\)|import pdb|pdb\.set_trace\(\))/, languages: ['python'], message: 'Debugger breakpoint left in code' },
  { id: 'todo', category: 'maintainability', severity: 'info', re: /\b(TODO|FIXME|XXX|HACK)\b/, message: 'Unresolved TODO/FIXME marker' },
  { id: 'ts-any', category: 'quality', severity: 'low', re: /:\s*any\b|as any\b/, languages: ['typescript'], message: 'Use of `any` weakens type safety' },
  { id: 'ts-ignore', category: 'quality', severity: 'low', re: /@ts-ignore|@ts-nocheck/, languages: ['typescript'], message: 'Type checking suppressed' },
  { id: 'empty-catch', category: 'reliability', severity: 'medium', re: /catch\s*(\([^)]*\))?\s*\{\s*\}/, languages: ['javascript', 'typescript'], message: 'Empty catch block swallows errors' },
  { id: 'py-bare-except', category: 'reliability', severity: 'medium', re: /^\s*except\s*:/, languages: ['python'], message: 'Bare except catches everything' },
]

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1, info: 0 }

export function staticReview(file: string, content: string, changedLines?: Set<number>): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  const language = languageOf(file)
  const lines = content.split('\n')
  const inScope = (line: number) => !changedLines || changedLines.has(line)
  for (const s of scanForSecrets(content)) {
    if (!inScope(s.line)) continue
    findings.push({ file, line: s.line, severity: s.severity === 'critical' ? 'critical' : 'high', category: 'security', rule: `secret:${s.patternId}`, message: `Possible ${s.description} committed (${s.preview})`, suggestion: 'Move secrets to environment variables or a secret manager and rotate the exposed credential.', source: 'static' })
  }
  for (let i = 0; i < lines.length; i++) {
    if (!inScope(i + 1)) continue
    const line = lines[i]!
    for (const rule of RULES) {
      if (rule.languages && !rule.languages.includes(language)) continue
      if (rule.re.test(line)) findings.push({ file, line: i + 1, severity: rule.severity, category: rule.category, rule: rule.id, message: rule.message, suggestion: rule.suggestion, source: 'static' })
    }
    if (line.length > 200 && !/\.(min\.|json|lock|svg|md)/.test(file)) findings.push({ file, line: i + 1, severity: 'info', category: 'style', rule: 'long-line', message: `Line is ${line.length} characters long`, source: 'static' })
  }
  if (lines.length > 800 && !changedLines) findings.push({ file, severity: 'low', category: 'maintainability', rule: 'large-file', message: `File has ${lines.length} lines; consider splitting it`, source: 'static' })
  try {
    for (const s of analyzeSource(file, content).symbols) {
      if ((s.kind === 'function' || s.kind === 'method') && s.endLine - s.line > 120 && (!changedLines || [...changedLines].some((l) => l >= s.line && l <= s.endLine))) {
        findings.push({ file, line: s.line, severity: 'low', category: 'maintainability', rule: 'long-function', message: `${s.kind} '${s.name}' is ${s.endLine - s.line} lines long`, suggestion: 'Extract smaller functions.', source: 'static' })
      }
    }
  } catch {
    // unparsable source; skip structure checks
  }
  return findings
}

export function scoreFindings(findings: ReviewFinding[]): number {
  const penalty = findings.reduce((acc, f) => acc + SEVERITY_WEIGHT[f.severity], 0)
  return Math.max(0, Math.min(100, 100 - penalty))
}

interface Row {
  id: string
  project_id: string
  target: string
  summary: string | null
  score: number | null
  findings: string
  ai_used: number
  created_at: string
}

export class CodeReviewEngine {
  constructor(
    private readonly db: Database,
    private readonly fs: FileSystemManager,
    private readonly git: GitService,
    private readonly router: AIRouter,
  ) {}

  /**
   * Review the working-tree diff (target "diff"), staged changes ("staged"),
   * or an explicit list of files.
   */
  async review(projectId: string, root: string, opts: { target?: 'diff' | 'staged' | 'files'; files?: string[]; ai?: boolean; model?: string; userId?: string; signal?: AbortSignal }): Promise<ReviewReport> {
    const target = opts.target ?? 'diff'
    const findings: ReviewFinding[] = []
    let reviewedMaterial = ''
    let label: string = target
    if (target === 'files') {
      const files = opts.files ?? []
      label = `files: ${files.join(', ')}`
      for (const f of files.slice(0, 50)) {
        const content = await this.fs.readText(root, f)
        findings.push(...staticReview(f, content))
        reviewedMaterial += `\n=== ${f} ===\n${content.slice(0, 20_000)}`
      }
    } else {
      const diff = await this.git.diff(root, { staged: target === 'staged' })
      reviewedMaterial = diff
      const patches = parsePatch(diff)
      const changedFiles: string[] = []
      for (const p of patches) {
        const file = p.newPath
        if (!file) continue
        changedFiles.push(file)
        const changed = new Set<number>()
        for (const h of p.hunks) {
          let ln = h.newStart
          for (const l of h.lines) {
            if (l.startsWith('+')) changed.add(ln)
            if (!l.startsWith('-')) ln++
          }
        }
        const content = await this.fs.readText(root, file).catch(() => null)
        if (content !== null) findings.push(...staticReview(file, content, changed))
      }
      const newSource = changedFiles.filter((f) => /\.(ts|tsx|js|py|go|rs|java)$/.test(f) && !/(test|spec)/i.test(f))
      const touchedTests = changedFiles.some((f) => /(test|spec)/i.test(f))
      if (newSource.length >= 2 && !touchedTests) findings.push({ file: newSource[0]!, severity: 'low', category: 'testing', rule: 'missing-tests', message: `${newSource.length} source files changed without any test changes`, suggestion: 'Add or update tests covering the change.', source: 'static' })
    }

    let aiUsed = false
    let aiSummary = ''
    if (opts.ai && reviewedMaterial.trim()) {
      try {
        const res = await this.router.chat(
          opts.model,
          {
            system:
              'You are a meticulous senior code reviewer. Review the provided changes for correctness bugs, security issues, performance problems and maintainability. Report only real, specific problems. Respond with JSON only: {"summary": string, "findings": [{"file": string, "line": number|null, "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "suggestion": string}]}',
            messages: [{ role: 'user', content: [{ type: 'text', text: `Review this ${target === 'files' ? 'code' : 'diff'}:\n\n${reviewedMaterial.slice(0, 120_000)}` }] }],
            maxTokens: 16000,
            effort: 'high',
            json: true,
            signal: opts.signal,
          },
          { userId: opts.userId },
        )
        const parsed = extractJson<{ summary?: string; findings?: Array<Partial<ReviewFinding>> }>(textOf(res.content))
        if (parsed) {
          aiUsed = true
          aiSummary = parsed.summary ?? ''
          for (const f of parsed.findings ?? []) {
            if (!f.message) continue
            findings.push({ file: f.file ?? '(general)', line: typeof f.line === 'number' ? f.line : undefined, severity: (['critical', 'high', 'medium', 'low', 'info'].includes(String(f.severity)) ? f.severity : 'medium') as Severity, category: f.category ?? 'ai', rule: 'ai-review', message: f.message, suggestion: f.suggestion, source: 'ai' })
          }
        }
      } catch (err) {
        aiSummary = `AI review unavailable: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info']
    findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
    const score = scoreFindings(findings)
    const counts = order.map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(', ')
    const summary = [`Score ${score}/100 — ${findings.length} findings (${counts}).`, aiSummary].filter(Boolean).join('\n')
    const id = newId('rev')
    this.db.insert('review_reports', { id, project_id: projectId, target: label, summary, score, findings: JSON.stringify(findings), ai_used: aiUsed ? 1 : 0, created_by: opts.userId ?? null, created_at: now() })
    return this.get(id)
  }

  get(id: string): ReviewReport {
    const r = this.db.get<Row>('SELECT * FROM review_reports WHERE id = ?', [id])!
    return { id: r.id, projectId: r.project_id, target: r.target, summary: r.summary ?? '', score: r.score ?? 0, findings: parseJson(r.findings, []), aiUsed: !!r.ai_used, createdAt: r.created_at }
  }

  history(projectId: string): ReviewReport[] {
    return this.db.all<Row>('SELECT * FROM review_reports WHERE project_id = ? ORDER BY created_at DESC LIMIT 50', [projectId]).map((r) => this.get(r.id))
  }
}
