/**
 * Module 17: Repository Analyzer
 *
 * Produces a structured overview of a codebase: language breakdown, lines of
 * code, detected frameworks and package managers, entry points, test setup,
 * build/test commands, a compact repository map for model context, and an
 * internal import graph.
 */
import path from 'node:path'
import type { FileSystemManager } from '../fs/file-system.js'
import { languageOf, SymbolIndex } from '../code/symbols.js'

export interface RepoAnalysis {
  root: string
  fileCount: number
  totalBytes: number
  totalLines: number
  languages: Array<{ language: string; files: number; lines: number; percent: number }>
  frameworks: string[]
  packageManagers: string[]
  entryPoints: string[]
  testDirs: string[]
  testCommand: string | null
  buildCommand: string | null
  hasDocker: boolean
  hasCi: boolean
  instructionsFiles: string[]
  topLevel: string[]
  largestFiles: Array<{ path: string; size: number }>
  repoMap: string
  importGraph: { nodes: number; edges: Array<[string, string]> }
  symbolCount: number
  analyzedAt: string
}

const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', '@angular/core': 'Angular',
  express: 'Express', fastify: 'Fastify', koa: 'Koa', '@nestjs/core': 'NestJS', hono: 'Hono', electron: 'Electron', vite: 'Vite',
  vitest: 'Vitest', jest: 'Jest', mocha: 'Mocha', playwright: 'Playwright', '@playwright/test': 'Playwright', tailwindcss: 'Tailwind CSS',
  prisma: 'Prisma', typeorm: 'TypeORM', mongoose: 'Mongoose', 'react-native': 'React Native', 'socket.io': 'Socket.IO', typescript: 'TypeScript',
}

const PY_FRAMEWORKS: Record<string, string> = { django: 'Django', flask: 'Flask', fastapi: 'FastAPI', pytest: 'pytest', torch: 'PyTorch', tensorflow: 'TensorFlow', numpy: 'NumPy', pandas: 'pandas', sqlalchemy: 'SQLAlchemy' }

export class RepositoryAnalyzer {
  constructor(private readonly fs: FileSystemManager) {}

  async analyze(root: string, index?: SymbolIndex): Promise<RepoAnalysis> {
    const files = await this.fs.listFiles(root, { limit: 30_000 })
    const byLang = new Map<string, { files: number; lines: number }>()
    let totalBytes = 0
    let totalLines = 0
    for (const f of files) {
      totalBytes += f.size
      const lang = languageOf(f.path)
      if (lang === 'text' || lang === 'json' || f.size > 1024 * 1024) {
        const e = byLang.get(lang) ?? { files: 0, lines: 0 }
        e.files++
        byLang.set(lang, e)
        continue
      }
      const content = await this.fs.read(root, f.path, { maxBytes: 1024 * 1024 }).catch(() => null)
      const lines = content && !content.binary ? content.content.split('\n').length : 0
      totalLines += lines
      const e = byLang.get(lang) ?? { files: 0, lines: 0 }
      e.files++
      e.lines += lines
      byLang.set(lang, e)
    }
    const codeLines = [...byLang.values()].reduce((a, b) => a + b.lines, 0) || 1
    const languages = [...byLang.entries()]
      .map(([language, v]) => ({ language, files: v.files, lines: v.lines, percent: Math.round((v.lines / codeLines) * 1000) / 10 }))
      .sort((a, b) => b.lines - a.lines || b.files - a.files)

    const paths = new Set(files.map((f) => f.path))
    const has = (p: string) => paths.has(p)
    const frameworks = new Set<string>()
    const packageManagers = new Set<string>()
    let testCommand: string | null = null
    let buildCommand: string | null = null
    const entryPoints: string[] = []

    if (has('package.json')) {
      const pkg = await this.readJson(root, 'package.json')
      const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, string>
      for (const d of Object.keys(deps)) if (FRAMEWORK_DEPS[d]) frameworks.add(FRAMEWORK_DEPS[d]!)
      packageManagers.add(has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm')
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm'
      const scripts = (pkg?.scripts ?? {}) as Record<string, string>
      if (scripts.test && !/no test specified/.test(scripts.test)) testCommand = `${pm} test`
      if (scripts.build) buildCommand = `${pm} run build`
      for (const k of ['main', 'module', 'bin']) {
        const v = pkg?.[k]
        if (typeof v === 'string') entryPoints.push(v)
        else if (v && typeof v === 'object') entryPoints.push(...(Object.values(v) as string[]))
      }
    }
    if (has('requirements.txt') || has('pyproject.toml') || has('setup.py') || has('Pipfile')) {
      packageManagers.add(has('poetry.lock') ? 'poetry' : has('uv.lock') ? 'uv' : has('Pipfile') ? 'pipenv' : 'pip')
      const req = (await this.fs.read(root, has('requirements.txt') ? 'requirements.txt' : has('pyproject.toml') ? 'pyproject.toml' : 'setup.py').catch(() => null))?.content.toLowerCase() ?? ''
      for (const [k, v] of Object.entries(PY_FRAMEWORKS)) if (new RegExp(`\\b${k}\\b`).test(req)) frameworks.add(v)
      testCommand ??= [...paths].some((p) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(p)) ? (req.includes('pytest') ? 'python -m pytest -q' : 'python -m unittest discover -v') : null
      for (const e of ['main.py', 'app.py', 'manage.py', 'src/main.py']) if (has(e)) entryPoints.push(e)
    }
    if (has('go.mod')) {
      packageManagers.add('go modules')
      frameworks.add('Go')
      testCommand ??= 'go test ./...'
      buildCommand ??= 'go build ./...'
    }
    if (has('Cargo.toml')) {
      packageManagers.add('cargo')
      frameworks.add('Rust')
      testCommand ??= 'cargo test'
      buildCommand ??= 'cargo build'
    }
    if (has('pom.xml')) {
      packageManagers.add('maven')
      testCommand ??= 'mvn -q test'
    }
    if (has('build.gradle') || has('build.gradle.kts')) {
      packageManagers.add('gradle')
      testCommand ??= './gradlew test'
    }
    if (has('composer.json')) packageManagers.add('composer')
    if (has('Gemfile')) packageManagers.add('bundler')
    if (has('Makefile') && !buildCommand) buildCommand = 'make'
    for (const e of ['src/index.ts', 'src/main.ts', 'src/index.js', 'index.js', 'main.go', 'cmd/main.go', 'src/main.rs', 'src/App.tsx', 'src/main.tsx', 'index.html']) if (has(e)) entryPoints.push(e)

    const testDirs = [...new Set(files.map((f) => f.path.split('/')[0]!).filter((d) => /^(tests?|__tests__|spec|e2e)$/.test(d)))]
    const topLevel = [...new Set(files.map((f) => f.path.split('/')[0]!))].sort()
    const idx = index ?? new SymbolIndex(this.fs, root)
    await idx.refresh()

    // Import graph (relative imports only).
    const edges: Array<[string, string]> = []
    for (const a of idx.analyses()) {
      for (const imp of a.imports) {
        if (!imp.startsWith('.')) continue
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(a.file), imp))
        const target = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`, base.replace(/\.js$/, '.ts')].find((c) => paths.has(c))
        if (target) edges.push([a.file, target])
      }
    }

    return {
      root,
      fileCount: files.length,
      totalBytes,
      totalLines,
      languages,
      frameworks: [...frameworks].sort(),
      packageManagers: [...packageManagers],
      entryPoints: [...new Set(entryPoints)],
      testDirs,
      testCommand,
      buildCommand,
      hasDocker: has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml'),
      hasCi: [...paths].some((p) => p.startsWith('.github/workflows/') || p === '.gitlab-ci.yml'),
      instructionsFiles: ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md', 'README.md'].filter(has),
      topLevel,
      largestFiles: [...files].sort((a, b) => b.size - a.size).slice(0, 10).map((f) => ({ path: f.path, size: f.size })),
      repoMap: this.buildRepoMap(files.map((f) => f.path), idx),
      importGraph: { nodes: idx.analyses().length, edges: edges.slice(0, 5000) },
      symbolCount: idx.allSymbols().length,
      analyzedAt: new Date().toISOString(),
    }
  }

  /** Compact tree with top exported symbols per file, capped for context windows. */
  buildRepoMap(paths: string[], index: SymbolIndex, maxChars = 12_000): string {
    const lines: string[] = []
    const sorted = [...paths].sort()
    for (const p of sorted) {
      const a = index.analysis(p)
      const syms = a?.symbols.filter((s) => !s.container && (s.exported || a.language === 'python')).slice(0, 8).map((s) => `${s.kind === 'class' ? 'class ' : s.kind === 'interface' ? 'interface ' : ''}${s.name}`)
      lines.push(syms?.length ? `${p}: ${syms.join(', ')}` : p)
      if (lines.join('\n').length > maxChars) {
        lines.push(`… (${sorted.length - lines.length} more files)`)
        break
      }
    }
    return lines.join('\n')
  }

  private async readJson(root: string, rel: string): Promise<Record<string, any> | null> {
    try {
      return JSON.parse(await this.fs.readText(root, rel)) as Record<string, any>
    } catch {
      return null
    }
  }
}
