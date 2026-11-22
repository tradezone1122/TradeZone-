/**
 * Module 19: Code Generation Engine
 *
 * Generates new files, tests and AI-driven edits using the model router,
 * grounded in project context (conventions from neighbouring files, repo map,
 * symbols). Output is parsed from fenced code blocks / SEARCH-REPLACE blocks;
 * results are returned as a preview diff and optionally written to disk
 * through the editing engine.
 */
import path from 'node:path'
import type { AIRouter } from '../router/ai-router.js'
import type { FileSystemManager } from '../fs/file-system.js'
import type { CodeEditingEngine, EditResult } from './editing.js'
import { parseSearchReplaceBlocks, applyStringEdits } from './editing.js'
import { unifiedDiff } from './diff.js'
import { languageOf } from './symbols.js'
import { textOf } from '../core/types.js'
import { ValidationError } from '../core/errors.js'

export interface GeneratedFile {
  path: string
  content: string
  diff: string
  existed: boolean
}

/** Extract `path`-annotated fenced code blocks: ```lang path=src/x.ts  or a "// file: x" first line. */
export function extractCodeBlocks(text: string): Array<{ path: string | null; lang: string | null; code: string }> {
  const out: Array<{ path: string | null; lang: string | null; code: string }> = []
  for (const m of text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
    const info = m[1]!.trim()
    let code = m[2]!
    let p: string | null = info.match(/(?:path|file)=["']?([^\s"']+)/)?.[1] ?? null
    const lang = info.split(/\s+/)[0] || null
    if (!p && lang && /[./]/.test(lang) && !/^[a-z]+$/.test(lang)) p = lang
    const first = code.split('\n')[0]!.match(/^\s*(?:\/\/|#|<!--|--)\s*(?:file|path):\s*(\S+)/i)
    if (!p && first) {
      p = first[1]!
      code = code.split('\n').slice(1).join('\n')
    }
    out.push({ path: p, lang: lang && !/[./]/.test(lang) ? lang : null, code: code.endsWith('\n') ? code : code + '\n' })
  }
  return out
}

export class CodeGenerationEngine {
  constructor(
    private readonly router: AIRouter,
    private readonly fs: FileSystemManager,
    private readonly editing: CodeEditingEngine,
  ) {}

  /** Collect style context: up to 3 sibling files of the same language. */
  async conventions(root: string, target: string): Promise<string> {
    const dir = path.posix.dirname(target)
    const lang = languageOf(target)
    const files = (await this.fs.listFiles(root, { limit: 5000, maxSize: 64 * 1024 })).filter((f) => languageOf(f.path) === lang && f.path !== target)
    const siblings = [...files.filter((f) => path.posix.dirname(f.path) === dir), ...files.filter((f) => path.posix.dirname(f.path) !== dir)].slice(0, 3)
    const parts: string[] = []
    for (const s of siblings) {
      const c = await this.fs.read(root, s.path, { maxBytes: 6000 }).catch(() => null)
      if (c && !c.binary) parts.push(`--- ${s.path} ---\n${c.content.slice(0, 4000)}`)
    }
    return parts.join('\n\n')
  }

  async generateFile(root: string, opts: { path: string; instructions: string; model?: string | null; write?: boolean; userId?: string; signal?: AbortSignal }): Promise<GeneratedFile> {
    let existing: string | null = null
    try {
      existing = await this.fs.readText(root, opts.path)
    } catch {
      existing = null
    }
    const style = await this.conventions(root, opts.path)
    const prompt = [
      `Write the complete contents of the file \`${opts.path}\` (${languageOf(opts.path)}).`,
      `Requirements:\n${opts.instructions}`,
      existing !== null ? `Current contents (rewrite fully):\n\`\`\`\n${existing.slice(0, 60_000)}\n\`\`\`` : '',
      style ? `Match the conventions of these existing project files:\n${style}` : '',
      'Respond with exactly one fenced code block containing the full file and nothing else.',
    ]
      .filter(Boolean)
      .join('\n\n')
    const res = await this.router.chat(opts.model, { system: 'You are an expert software engineer who writes complete, correct, production-quality code that fits the existing codebase.', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 32000, effort: 'high', signal: opts.signal }, { userId: opts.userId })
    const blocks = extractCodeBlocks(textOf(res.content))
    const code = blocks[0]?.code
    if (!code) throw new ValidationError('The model did not return a code block')
    const { diff } = unifiedDiff(existing ?? '', code, existing !== null ? `a/${opts.path}` : '/dev/null', `b/${opts.path}`)
    if (opts.write) await this.editing.writeFile(root, opts.path, code)
    return { path: opts.path, content: code, diff, existed: existing !== null }
  }

  async generateTests(root: string, opts: { source: string; testPath?: string; framework?: string; model?: string | null; write?: boolean; userId?: string; signal?: AbortSignal }): Promise<GeneratedFile> {
    const source = await this.fs.readText(root, opts.source)
    const ext = path.posix.extname(opts.source)
    const base = opts.source.slice(0, -ext.length)
    const testPath = opts.testPath ?? (languageOf(opts.source) === 'python' ? path.posix.join(path.posix.dirname(opts.source), `test_${path.posix.basename(base)}.py`) : `${base}.test${ext}`)
    return this.generateFile(root, {
      path: testPath,
      instructions: `Unit tests for \`${opts.source}\`${opts.framework ? ` using ${opts.framework}` : ' using the framework already used in this project'}. Cover main behavior, edge cases and error handling. Import from the correct relative path.\n\nSource under test:\n\`\`\`\n${source.slice(0, 50_000)}\n\`\`\``,
      model: opts.model,
      write: opts.write,
      userId: opts.userId,
      signal: opts.signal,
    })
  }

  /** AI edit: the model answers with SEARCH/REPLACE blocks that are validated before writing. */
  async aiEdit(root: string, opts: { path: string; instruction: string; model?: string | null; write?: boolean; userId?: string; signal?: AbortSignal }): Promise<{ results: EditResult[]; preview: GeneratedFile }> {
    const before = await this.fs.readText(root, opts.path)
    const prompt = `Edit \`${opts.path}\` to accomplish:\n${opts.instruction}\n\nCurrent file:\n\`\`\`\n${before.slice(0, 80_000)}\n\`\`\`\n\nRespond ONLY with one or more blocks in this exact format (SEARCH text must match the file exactly, including whitespace):\n${opts.path}\n<<<<<<< SEARCH\n<exact existing lines>\n=======\n<replacement lines>\n>>>>>>> REPLACE`
    const res = await this.router.chat(opts.model, { system: 'You are a precise code editor. You make minimal, correct edits.', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 16000, effort: 'medium', signal: opts.signal }, { userId: opts.userId })
    const text = textOf(res.content)
    const blocks = parseSearchReplaceBlocks(text)
    if (!blocks.length) throw new ValidationError('The model did not return SEARCH/REPLACE edits')
    const after = applyStringEdits(before, blocks.map((b) => ({ oldString: b.search, newString: b.replace })), opts.path)
    const { diff } = unifiedDiff(before, after, `a/${opts.path}`, `b/${opts.path}`)
    let results: EditResult[] = []
    if (opts.write) results = await this.editing.applySearchReplace(root, text, opts.path)
    return { results, preview: { path: opts.path, content: after, diff, existed: true } }
  }
}
