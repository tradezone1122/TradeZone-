/**
 * Module 18: Code Understanding Engine
 *
 * Extracts symbols (functions, classes, methods, interfaces, types, variables,
 * imports/exports) from source files. JavaScript/TypeScript use the real
 * TypeScript compiler AST; other languages use line-oriented grammars.
 * Builds a per-project symbol index with search, outlines and references.
 */
import ts from 'typescript'
import path from 'node:path'
import type { FileSystemManager } from '../fs/file-system.js'

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable' | 'struct' | 'trait' | 'module' | 'constant' | 'property'

export interface CodeSymbol {
  name: string
  kind: SymbolKind
  file: string
  line: number
  endLine: number
  container?: string
  exported: boolean
  signature?: string
}

export interface FileAnalysis {
  file: string
  language: string
  symbols: CodeSymbol[]
  imports: string[]
  exports: string[]
  lines: number
}

export const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp',
  '.php': 'php', '.rb': 'ruby', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp',
  '.swift': 'swift', '.scala': 'scala', '.sh': 'shell', '.bash': 'shell', '.sql': 'sql', '.vue': 'vue', '.svelte': 'svelte',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.lua': 'lua', '.dart': 'dart', '.r': 'r', '.ex': 'elixir', '.exs': 'elixir', '.zig': 'zig',
}

export function languageOf(file: string): string {
  const base = path.basename(file).toLowerCase()
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  return LANGUAGE_BY_EXT[path.extname(file).toLowerCase()] ?? 'text'
}

export function analyzeSource(file: string, content: string): FileAnalysis {
  const language = languageOf(file)
  const lines = content.split('\n').length
  if (language === 'typescript' || language === 'javascript') return { ...analyzeTs(file, content), language, lines }
  const grammar = GRAMMARS[language]
  if (!grammar) return { file, language, symbols: [], imports: [], exports: [], lines }
  return { ...analyzeWithGrammar(file, content, grammar), language, lines }
}

function analyzeTs(file: string, content: string): Omit<FileAnalysis, 'language' | 'lines'> {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : file.match(/\.(m|c)?js$/) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  const symbols: CodeSymbol[] = []
  const imports: string[] = []
  const exports: string[] = []
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const isExported = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
  const sig = (n: ts.Node) => content.slice(n.getStart(sf), Math.min(n.getEnd(), n.getStart(sf) + 160)).split('{')[0]!.replace(/\s+/g, ' ').trim()
  const push = (name: string, k: SymbolKind, n: ts.Node, container?: string, exported = false) => {
    symbols.push({ name, kind: k, file, line: lineOf(n.getStart(sf)), endLine: lineOf(n.getEnd()), container, exported, signature: sig(n) })
    if (exported) exports.push(name)
  }
  const visit = (node: ts.Node, container?: string) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
    else if (ts.isCallExpression(node) && node.expression.getText(sf) === 'require' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text)
    if (ts.isFunctionDeclaration(node) && node.name) push(node.name.text, 'function', node, container, isExported(node))
    else if (ts.isClassDeclaration(node) && node.name) {
      push(node.name.text, 'class', node, container, isExported(node))
      node.members.forEach((m) => {
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name) push(m.name.getText(sf), 'method', m, node.name!.text)
        else if (ts.isConstructorDeclaration(m)) push('constructor', 'method', m, node.name!.text)
        else if (ts.isPropertyDeclaration(m) && m.name) push(m.name.getText(sf), 'property', m, node.name!.text)
      })
      return
    } else if (ts.isInterfaceDeclaration(node)) push(node.name.text, 'interface', node, container, isExported(node))
    else if (ts.isTypeAliasDeclaration(node)) push(node.name.text, 'type', node, container, isExported(node))
    else if (ts.isEnumDeclaration(node)) push(node.name.text, 'enum', node, container, isExported(node))
    else if (ts.isModuleDeclaration(node)) push(node.name.getText(sf), 'module', node, container, isExported(node))
    else if (ts.isVariableStatement(node) && node.parent === sf) {
      const exported = isExported(node)
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        const init = d.initializer
        const k: SymbolKind = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? 'function' : node.declarationList.flags & ts.NodeFlags.Const ? 'constant' : 'variable'
        push(d.name.text, k, d, container, exported)
      }
    } else if (ts.isExportAssignment(node)) exports.push('default')
    ts.forEachChild(node, (c) => visit(c, container))
  }
  visit(sf)
  return { file, symbols, imports: [...new Set(imports)], exports: [...new Set(exports)] }
}

interface Grammar {
  rules: Array<{ re: RegExp; kind: SymbolKind; exported?: (m: RegExpMatchArray, line: string) => boolean; nameGroup?: number }>
  imports: RegExp[]
  /** Indentation-based languages compute endLine from indentation. */
  indentBlocks?: boolean
}

const GRAMMARS: Record<string, Grammar> = {
  python: {
    indentBlocks: true,
    rules: [
      { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function', nameGroup: 2, exported: (m) => !m[2]!.startsWith('_') },
      { re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: 'class', nameGroup: 2, exported: (m) => !m[2]!.startsWith('_') },
      { re: /^()([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=/, kind: 'constant', nameGroup: 2, exported: () => true },
    ],
    imports: [/^\s*import\s+([\w.]+)/, /^\s*from\s+([\w.]+)\s+import/],
  },
  go: {
    rules: [
      { re: /^func\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(\w+)\s*\(/, kind: 'method', nameGroup: 2, exported: (m) => /^[A-Z]/.test(m[2]!) },
      { re: /^func\s+(\w+)\s*[(\[]/, kind: 'function', nameGroup: 1, exported: (m) => /^[A-Z]/.test(m[1]!) },
      { re: /^type\s+(\w+)\s+struct\b/, kind: 'struct', nameGroup: 1, exported: (m) => /^[A-Z]/.test(m[1]!) },
      { re: /^type\s+(\w+)\s+interface\b/, kind: 'interface', nameGroup: 1, exported: (m) => /^[A-Z]/.test(m[1]!) },
      { re: /^type\s+(\w+)\s+/, kind: 'type', nameGroup: 1, exported: (m) => /^[A-Z]/.test(m[1]!) },
    ],
    imports: [/^\s*import\s+"([^"]+)"/, /^\s+(?:\w+\s+)?"([^"]+)"$/],
  },
  rust: {
    rules: [
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, kind: 'function', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: 'struct', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: 'enum', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: 'trait', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/, kind: 'module', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?type\s+(\w+)/, kind: 'type', nameGroup: 2, exported: (m) => !!m[1] },
    ],
    imports: [/^\s*use\s+([\w:]+)/],
  },
  java: {
    rules: [
      { re: /^\s*(public\s+)?(?:abstract\s+|final\s+|static\s+)*class\s+(\w+)/, kind: 'class', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(public\s+)?interface\s+(\w+)/, kind: 'interface', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(public\s+)?enum\s+(\w+)/, kind: 'enum', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(public\s+|protected\s+|private\s+)(?:static\s+|final\s+|synchronized\s+|abstract\s+)*[\w<>\[\],\s]+\s+(\w+)\s*\([^;]*$/, kind: 'method', nameGroup: 2, exported: (m) => m[1]?.trim() === 'public' },
    ],
    imports: [/^\s*import\s+([\w.*]+);/],
  },
  kotlin: {
    rules: [
      { re: /^\s*(private\s+|internal\s+)?(?:data\s+|sealed\s+|open\s+|abstract\s+)*class\s+(\w+)/, kind: 'class', nameGroup: 2, exported: (m) => !m[1] },
      { re: /^\s*(private\s+|internal\s+)?(?:suspend\s+)?fun\s+(?:<[^>]+>\s*)?(?:\w+\.)?(\w+)\s*\(/, kind: 'function', nameGroup: 2, exported: (m) => !m[1] },
      { re: /^\s*(private\s+)?interface\s+(\w+)/, kind: 'interface', nameGroup: 2, exported: (m) => !m[1] },
    ],
    imports: [/^\s*import\s+([\w.*]+)/],
  },
  csharp: {
    rules: [
      { re: /^\s*(public\s+)?(?:internal\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)*class\s+(\w+)/, kind: 'class', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(public\s+)?interface\s+(\w+)/, kind: 'interface', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(public\s+)?(?:struct|record)\s+(\w+)/, kind: 'struct', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(public\s+|private\s+|protected\s+|internal\s+)(?:static\s+|async\s+|override\s+|virtual\s+)*[\w<>\[\],?\s]+\s+(\w+)\s*\([^;]*$/, kind: 'method', nameGroup: 2, exported: (m) => m[1]?.trim() === 'public' },
    ],
    imports: [/^\s*using\s+([\w.]+);/],
  },
  php: {
    rules: [
      { re: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: 'class', nameGroup: 1, exported: () => true },
      { re: /^\s*interface\s+(\w+)/, kind: 'interface', nameGroup: 1, exported: () => true },
      { re: /^\s*trait\s+(\w+)/, kind: 'trait', nameGroup: 1, exported: () => true },
      { re: /^\s*(public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+(\w+)/, kind: 'function', nameGroup: 2, exported: (m) => m[1]?.trim() !== 'private' },
    ],
    imports: [/^\s*use\s+([\w\\]+)/, /^\s*(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)/],
  },
  ruby: {
    rules: [
      { re: /^\s*class\s+([A-Z]\w*)/, kind: 'class', nameGroup: 1, exported: () => true },
      { re: /^\s*module\s+([A-Z]\w*)/, kind: 'module', nameGroup: 1, exported: () => true },
      { re: /^\s*def\s+(?:self\.)?(\w+[?!=]?)/, kind: 'method', nameGroup: 1, exported: () => true },
    ],
    imports: [/^\s*require(?:_relative)?\s+['"]([^'"]+)/],
  },
  c: {
    rules: [
      { re: /^(?!\s)(?:static\s+)?(?:inline\s+)?[\w\s\*]+?\b(\w+)\s*\([^;]*\)\s*\{?\s*$/, kind: 'function', nameGroup: 1, exported: (_m, l) => !l.startsWith('static') },
      { re: /^\s*(?:typedef\s+)?struct\s+(\w+)/, kind: 'struct', nameGroup: 1, exported: () => true },
      { re: /^\s*#define\s+([A-Z_][A-Z0-9_]*)/, kind: 'constant', nameGroup: 1, exported: () => true },
    ],
    imports: [/^\s*#include\s+[<"]([^>"]+)/],
  },
  swift: {
    rules: [
      { re: /^\s*(public\s+|open\s+)?(?:final\s+)?class\s+(\w+)/, kind: 'class', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(public\s+)?struct\s+(\w+)/, kind: 'struct', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(public\s+)?protocol\s+(\w+)/, kind: 'interface', nameGroup: 2, exported: (m) => !!m[1] },
      { re: /^\s*(public\s+|private\s+)?(?:static\s+)?func\s+(\w+)/, kind: 'function', nameGroup: 2, exported: (m) => m[1]?.trim() === 'public' },
    ],
    imports: [/^\s*import\s+(\w+)/],
  },
}
GRAMMARS.cpp = GRAMMARS.c!

function analyzeWithGrammar(file: string, content: string, g: Grammar): Omit<FileAnalysis, 'language' | 'lines'> {
  const lines = content.split('\n')
  const symbols: CodeSymbol[] = []
  const imports: string[] = []
  const classStack: Array<{ name: string; indent: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    for (const imp of g.imports) {
      const m = line.match(imp)
      if (m?.[1]) imports.push(m[1])
    }
    for (const rule of g.rules) {
      const m = line.match(rule.re)
      if (!m) continue
      const name = m[rule.nameGroup ?? 1]
      if (!name || ['if', 'for', 'while', 'switch', 'return', 'catch', 'else'].includes(name)) continue
      const indent = line.length - line.trimStart().length
      let endLine = i + 1
      if (g.indentBlocks) {
        let j = i + 1
        while (j < lines.length && (lines[j]!.trim() === '' || lines[j]!.length - lines[j]!.trimStart().length > indent)) j++
        endLine = j
      } else {
        endLine = findBraceEnd(lines, i)
      }
      while (classStack.length && classStack[classStack.length - 1]!.indent >= indent && g.indentBlocks) classStack.pop()
      let kind = rule.kind
      const container = g.indentBlocks ? classStack[classStack.length - 1]?.name : undefined
      if (kind === 'function' && container) kind = 'method'
      symbols.push({ name, kind, file, line: i + 1, endLine, container, exported: rule.exported ? rule.exported(m, line) : true, signature: line.trim().slice(0, 160) })
      if (kind === 'class' && g.indentBlocks) classStack.push({ name, indent })
      break
    }
  }
  return { file, symbols, imports: [...new Set(imports)], exports: symbols.filter((s) => s.exported && !s.container).map((s) => s.name) }
}

function findBraceEnd(lines: string[], start: number): number {
  let depth = 0
  let seen = false
  for (let i = start; i < Math.min(lines.length, start + 2000); i++) {
    for (const ch of lines[i]!) {
      if (ch === '{') {
        depth++
        seen = true
      } else if (ch === '}') {
        depth--
        if (seen && depth === 0) return i + 1
      }
    }
    if (!seen && i > start + 2) return start + 1
  }
  return start + 1
}

/** Per-project symbol index, rebuilt incrementally by mtime. */
export class SymbolIndex {
  private files = new Map<string, { mtimeMs: number; analysis: FileAnalysis }>()

  constructor(
    private readonly fs: FileSystemManager,
    readonly root: string,
  ) {}

  async refresh(maxFiles = 5000): Promise<{ files: number; symbols: number; updated: number }> {
    const entries = (await this.fs.listFiles(this.root, { maxSize: 512 * 1024 })).filter((f) => GRAMMARS[languageOf(f.path)] || /\.(m|c)?[jt]sx?$/.test(f.path)).slice(0, maxFiles)
    const seen = new Set<string>()
    let updated = 0
    for (const f of entries) {
      seen.add(f.path)
      const cached = this.files.get(f.path)
      if (cached && cached.mtimeMs === f.mtimeMs) continue
      const file = await this.fs.read(this.root, f.path).catch(() => null)
      if (!file || file.binary) continue
      this.files.set(f.path, { mtimeMs: f.mtimeMs, analysis: analyzeSource(f.path, file.content) })
      updated++
    }
    for (const k of [...this.files.keys()]) if (!seen.has(k)) this.files.delete(k)
    return { files: this.files.size, symbols: this.allSymbols().length, updated }
  }

  allSymbols(): CodeSymbol[] {
    return [...this.files.values()].flatMap((f) => f.analysis.symbols)
  }

  analysis(file: string): FileAnalysis | undefined {
    return this.files.get(file)?.analysis
  }

  analyses(): FileAnalysis[] {
    return [...this.files.values()].map((f) => f.analysis)
  }

  search(query: string, opts: { kind?: SymbolKind; limit?: number } = {}): CodeSymbol[] {
    const q = query.toLowerCase()
    const scored: Array<{ s: CodeSymbol; score: number }> = []
    for (const s of this.allSymbols()) {
      if (opts.kind && s.kind !== opts.kind) continue
      const n = s.name.toLowerCase()
      let score = 0
      if (n === q) score = 100
      else if (n.startsWith(q)) score = 70
      else if (n.includes(q)) score = 40
      else if (fuzzy(q, n)) score = 15
      if (score) scored.push({ s, score: score + (s.exported ? 5 : 0) })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 50).map((x) => x.s)
  }

  /** Files that import the given file (relative-import resolution for JS/TS/Python). */
  dependents(file: string): string[] {
    const target = file.replace(/\.(m|c)?[jt]sx?$|\.py$/, '')
    const out: string[] = []
    for (const a of this.analyses()) {
      for (const imp of a.imports) {
        if (!imp.startsWith('.')) continue
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(a.file), imp)).replace(/\.(m|c)?[jt]sx?$/, '')
        if (resolved === target || resolved === target.replace(/\/index$/, '')) out.push(a.file)
      }
    }
    return [...new Set(out)]
  }
}

function fuzzy(q: string, s: string): boolean {
  let i = 0
  for (const ch of s) if (ch === q[i]) i++
  return i === q.length
}
