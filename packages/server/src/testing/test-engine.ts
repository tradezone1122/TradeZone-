/**
 * Module 26: Testing Engine
 *
 * Detects the project's test framework, runs tests with a timeout, parses the
 * output of common runners (Vitest, Jest, node:test, Mocha, pytest, unittest,
 * go test, cargo test) into structured pass/fail counts and failure details,
 * and stores every run.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Database } from '../db/database.js'
import { newId, now, parseJson } from '../db/database.js'
import { runShell, type RunResult } from '../terminal/process.js'
import type { CommandPolicy } from '../security/sandbox.js'
import type { EventBus } from '../events/bus.js'

export interface TestFailure {
  name: string
  file?: string
  line?: number
  message: string
}

export interface TestRunResult {
  id: string
  projectId: string
  command: string
  framework: string | null
  status: 'passed' | 'failed' | 'error' | 'timeout'
  passed: number
  failed: number
  skipped: number
  durationMs: number
  output: string
  failures: TestFailure[]
  createdAt: string
}

export function detectTestCommand(root: string): { command: string; framework: string } | null {
  const pkgPath = path.join(root, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      const script = pkg.scripts?.test
      const framework = deps.vitest ? 'vitest' : deps.jest ? 'jest' : deps.mocha ? 'mocha' : script?.includes('node --test') ? 'node:test' : 'npm'
      const pm = existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm'
      if (script && !/no test specified/.test(script)) return { command: `${pm} test`, framework }
      if (deps.vitest) return { command: 'npx vitest run', framework: 'vitest' }
      if (deps.jest) return { command: 'npx jest', framework: 'jest' }
    } catch {
      /* ignore malformed package.json */
    }
  }
  if (existsSync(path.join(root, 'go.mod'))) return { command: 'go test ./...', framework: 'go' }
  if (existsSync(path.join(root, 'Cargo.toml'))) return { command: 'cargo test', framework: 'cargo' }
  if (existsSync(path.join(root, 'pytest.ini')) || existsSync(path.join(root, 'conftest.py'))) return { command: 'python3 -m pytest -q', framework: 'pytest' }
  if (existsSync(path.join(root, 'pyproject.toml')) || existsSync(path.join(root, 'tests')) || existsSync(path.join(root, 'setup.py'))) {
    const py = existsSync(path.join(root, 'pyproject.toml')) ? readFileSync(path.join(root, 'pyproject.toml'), 'utf8') : ''
    return py.includes('pytest') ? { command: 'python3 -m pytest -q', framework: 'pytest' } : { command: 'python3 -m unittest discover -v', framework: 'unittest' }
  }
  if (existsSync(path.join(root, 'pom.xml'))) return { command: 'mvn -q test', framework: 'maven' }
  if (existsSync(path.join(root, 'Makefile')) && /^test:/m.test(readFileSync(path.join(root, 'Makefile'), 'utf8'))) return { command: 'make test', framework: 'make' }
  return null
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

/** Parse runner output into counts and failures. Exported for unit tests. */
export function parseTestOutput(rawOutput: string, framework: string | null): { passed: number; failed: number; skipped: number; failures: TestFailure[] } {
  const out = strip(rawOutput)
  let passed = 0
  let failed = 0
  let skipped = 0
  const failures: TestFailure[] = []
  let m: RegExpMatchArray | null
  // Vitest / Jest: "Tests  3 failed | 10 passed (13)" or "Tests: 1 failed, 2 skipped, 5 passed, 8 total"
  if ((m = out.match(/Tests?:?\s+(.*?)\(\d+\)/)) || (m = out.match(/Tests:\s+(.*?total)/))) {
    const seg = m[1]!
    passed = Number(seg.match(/(\d+) passed/)?.[1] ?? 0)
    failed = Number(seg.match(/(\d+) failed/)?.[1] ?? 0)
    skipped = Number(seg.match(/(\d+) (?:skipped|todo|pending)/)?.[1] ?? 0)
    for (const fm of out.matchAll(/(?:FAIL|×|✕)\s+(.+?)(?:\s+\[\s*(.+?):(\d+)|\n)/g)) failures.push({ name: fm[1]!.trim(), file: fm[2], line: fm[3] ? Number(fm[3]) : undefined, message: '' })
  }
  // node:test TAP summary
  else if ((m = out.match(/^# pass (\d+)/m))) {
    passed = Number(m[1])
    failed = Number(out.match(/^# fail (\d+)/m)?.[1] ?? 0)
    skipped = Number(out.match(/^# skipped (\d+)/m)?.[1] ?? 0) + Number(out.match(/^# todo (\d+)/m)?.[1] ?? 0)
    for (const fm of out.matchAll(/^not ok \d+ - (.+)$/gm)) failures.push({ name: fm[1]!.trim(), message: '' })
    // node:test spec reporter
  } else if ((m = out.match(/ℹ pass (\d+)/))) {
    passed = Number(m[1])
    failed = Number(out.match(/ℹ fail (\d+)/)?.[1] ?? 0)
    skipped = Number(out.match(/ℹ skipped (\d+)/)?.[1] ?? 0)
    for (const fm of out.matchAll(/^\s*✖ (.+?) \(\d/gm)) failures.push({ name: fm[1]!.trim(), message: '' })
  }
  // pytest: "=== 2 failed, 10 passed, 1 skipped in 0.12s ==="
  else if ((m = out.match(/=+ (.*?(?:passed|failed|error).*?) in [\d.]+s/))) {
    const seg = m[1]!
    passed = Number(seg.match(/(\d+) passed/)?.[1] ?? 0)
    failed = Number(seg.match(/(\d+) failed/)?.[1] ?? 0) + Number(seg.match(/(\d+) errors?/)?.[1] ?? 0)
    skipped = Number(seg.match(/(\d+) skipped/)?.[1] ?? 0)
    for (const fm of out.matchAll(/^FAILED (\S+?)(?:::(\S+))?(?: - (.*))?$/gm)) failures.push({ name: fm[2] ?? fm[1]!, file: fm[1]!.split('::')[0], message: fm[3] ?? '' })
  }
  // unittest: "Ran 5 tests in 0.001s" + "FAILED (failures=1, errors=1)" / "OK"
  else if ((m = out.match(/Ran (\d+) tests? in/))) {
    const total = Number(m[1])
    const f = Number(out.match(/failures=(\d+)/)?.[1] ?? 0) + Number(out.match(/errors=(\d+)/)?.[1] ?? 0)
    skipped = Number(out.match(/skipped=(\d+)/)?.[1] ?? 0)
    failed = f
    passed = total - f - skipped
    for (const fm of out.matchAll(/^(?:FAIL|ERROR): (\w+) \(([\w.]+)\)/gm)) failures.push({ name: `${fm[2]}.${fm[1]}`, message: '' })
  }
  // go test
  else if (framework === 'go' || /^(ok|FAIL|---)\s/m.test(out)) {
    passed = (out.match(/^\s*--- PASS/gm) ?? []).length
    failed = (out.match(/^\s*--- FAIL/gm) ?? []).length
    skipped = (out.match(/^\s*--- SKIP/gm) ?? []).length
    if (!passed && !failed) {
      passed = (out.match(/^ok\s/gm) ?? []).length
      failed = (out.match(/^FAIL\s/gm) ?? []).length
    }
    for (const fm of out.matchAll(/^\s*--- FAIL: (\S+)/gm)) failures.push({ name: fm[1]!, message: '' })
  }
  // cargo test: "test result: FAILED. 1 passed; 1 failed; 0 ignored"
  else if ((m = out.match(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/))) {
    passed = Number(m[1])
    failed = Number(m[2])
    skipped = Number(m[3])
    for (const fm of out.matchAll(/^test (\S+) \.\.\. FAILED/gm)) failures.push({ name: fm[1]!, message: '' })
  }
  // Mocha: "  5 passing" "  1 failing"
  else if ((m = out.match(/(\d+) passing/))) {
    passed = Number(m[1])
    failed = Number(out.match(/(\d+) failing/)?.[1] ?? 0)
    skipped = Number(out.match(/(\d+) pending/)?.[1] ?? 0)
  }
  // Attach assertion messages near failure names.
  for (const f of failures) {
    if (f.message) continue
    const idx = out.indexOf(f.name)
    const tail = idx >= 0 ? out.slice(idx, idx + 1500) : ''
    const msg = tail.match(/(AssertionError[^\n]*|Error:[^\n]*|expected[^\n]*|assert[^\n]*)/i)
    f.message = msg?.[1]?.trim().slice(0, 500) ?? ''
  }
  return { passed, failed, skipped, failures: failures.slice(0, 100) }
}

interface Row {
  id: string
  project_id: string
  command: string
  framework: string | null
  status: TestRunResult['status']
  passed: number
  failed: number
  skipped: number
  duration_ms: number
  output: string
  failures: string
  created_at: string
}

const toResult = (r: Row): TestRunResult => ({
  id: r.id,
  projectId: r.project_id,
  command: r.command,
  framework: r.framework,
  status: r.status,
  passed: r.passed,
  failed: r.failed,
  skipped: r.skipped,
  durationMs: r.duration_ms,
  output: r.output,
  failures: parseJson(r.failures, []),
  createdAt: r.created_at,
})

export class TestingEngine {
  constructor(
    private readonly db: Database,
    private readonly policy: CommandPolicy,
    private readonly bus: EventBus,
  ) {}

  async run(projectId: string, root: string, opts: { command?: string; timeoutMs?: number; signal?: AbortSignal; filter?: string } = {}): Promise<TestRunResult> {
    const detected = detectTestCommand(root)
    let command = opts.command ?? detected?.command
    const framework = opts.command ? frameworkFromCommand(opts.command) : (detected?.framework ?? null)
    if (!command) {
      return this.store({ projectId, command: '(none)', framework: null, status: 'error', passed: 0, failed: 0, skipped: 0, durationMs: 0, output: 'No test command configured or detected. Set one in project settings.', failures: [] })
    }
    if (opts.filter) command += ` ${shellQuote(opts.filter)}`
    this.bus.publish(`project:${projectId}`, 'tests.started', { command })
    let res: RunResult
    try {
      res = await runShell(command, {
        cwd: root,
        timeoutMs: opts.timeoutMs ?? 10 * 60_000,
        signal: opts.signal,
        onOutput: (chunk) => this.bus.publish(`project:${projectId}`, 'tests.output', { chunk }),
      }, this.policy)
    } catch (err) {
      return this.store({ projectId, command, framework, status: 'error', passed: 0, failed: 0, skipped: 0, durationMs: 0, output: String(err instanceof Error ? err.message : err), failures: [] })
    }
    const output = `${res.stdout}\n${res.stderr}`.trim()
    const parsed = parseTestOutput(output, framework)
    const status: TestRunResult['status'] = res.timedOut ? 'timeout' : res.exitCode === 0 && parsed.failed === 0 ? 'passed' : 'failed'
    const result = this.store({ projectId, command, framework, status, ...parsed, durationMs: res.durationMs, output: output.slice(-200_000) })
    this.bus.publish(`project:${projectId}`, 'tests.finished', { id: result.id, status, passed: result.passed, failed: result.failed })
    return result
  }

  private store(r: Omit<TestRunResult, 'id' | 'createdAt'>): TestRunResult {
    const id = newId('test')
    this.db.insert('test_runs', {
      id,
      project_id: r.projectId,
      command: r.command,
      framework: r.framework,
      status: r.status,
      passed: r.passed,
      failed: r.failed,
      skipped: r.skipped,
      duration_ms: r.durationMs,
      output: r.output,
      failures: JSON.stringify(r.failures),
      created_at: now(),
    })
    return this.get(id)
  }

  get(id: string): TestRunResult {
    return toResult(this.db.get<Row>('SELECT * FROM test_runs WHERE id = ?', [id])!)
  }

  history(projectId: string, limit = 50): TestRunResult[] {
    return this.db.all<Row>('SELECT * FROM test_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, limit]).map((r) => ({ ...toResult(r), output: r.output.slice(-4000) }))
  }
}

function frameworkFromCommand(cmd: string): string | null {
  if (/vitest/.test(cmd)) return 'vitest'
  if (/jest/.test(cmd)) return 'jest'
  if (/pytest/.test(cmd)) return 'pytest'
  if (/unittest/.test(cmd)) return 'unittest'
  if (/go test/.test(cmd)) return 'go'
  if (/cargo test/.test(cmd)) return 'cargo'
  if (/node --test/.test(cmd)) return 'node:test'
  return null
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
