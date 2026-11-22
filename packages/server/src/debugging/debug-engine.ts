/**
 * Module 27: Debugging Engine
 *
 * Parses stack traces and compiler errors from JavaScript/TypeScript, Python,
 * Go, Rust, Java and tsc output; maps frames to project files; extracts
 * surrounding source; and can reproduce an error by running a command. The
 * structured result is what the debugger agent receives as context.
 */
import type { FileSystemManager } from '../fs/file-system.js'
import { runShell } from '../terminal/process.js'
import type { CommandPolicy } from '../security/sandbox.js'

export interface StackFrame {
  file: string
  line: number
  column?: number
  function?: string
  inProject: boolean
}

export interface ParsedError {
  language: string
  errorType: string
  message: string
  frames: StackFrame[]
}

export interface DebugContext {
  error: ParsedError
  snippets: Array<{ file: string; line: number; startLine: number; code: string }>
  hints: string[]
}

export function parseErrorOutput(output: string, projectRoot?: string): ParsedError[] {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '')
  const errors: ParsedError[] = []
  const inProject = (file: string) => !file.includes('node_modules') && !file.startsWith('node:') && !file.includes('site-packages') && !file.startsWith('/usr/') && (!projectRoot || !file.startsWith('/') || file.startsWith(projectRoot))
  const rel = (file: string) => (projectRoot && file.startsWith(projectRoot) ? file.slice(projectRoot.length).replace(/^\/+/, '') : file.replace(/^file:\/\//, ''))

  // Python tracebacks
  for (const block of text.matchAll(/Traceback \(most recent call last\):\n([\s\S]*?)\n(\w[\w.]*(?:Error|Exception|Exit|Interrupt|Warning)?): ?(.*)/g)) {
    const frames: StackFrame[] = []
    for (const fm of block[1]!.matchAll(/File "([^"]+)", line (\d+)(?:, in (\S+))?/g)) frames.push({ file: rel(fm[1]!), line: Number(fm[2]), function: fm[3], inProject: inProject(fm[1]!) })
    errors.push({ language: 'python', errorType: block[2]!, message: block[3]!.trim(), frames: frames.reverse() })
  }

  // JS/TS stack traces: "TypeError: x is not a function\n    at fn (/path/file.js:10:5)"
  for (const block of text.matchAll(/^(?:Uncaught )?(\w*(?:Error|Exception))(?: \[\w+\])?: (.*)\n((?:\s+at .*\n?)+)/gm)) {
    const frames: StackFrame[] = []
    for (const fm of block[3]!.matchAll(/at (?:(.+?) \()?((?:file:\/\/)?[^\s()]+?):(\d+):(\d+)\)?/g)) {
      frames.push({ file: rel(fm[2]!), line: Number(fm[3]), column: Number(fm[4]), function: fm[1], inProject: inProject(fm[2]!) })
    }
    errors.push({ language: 'javascript', errorType: block[1]!, message: block[2]!.trim(), frames })
  }

  // TypeScript compiler: "src/a.ts(10,5): error TS2322: ..." or "src/a.ts:10:5 - error TS2322: ..."
  for (const fm of text.matchAll(/^([\w./@-]+\.tsx?)(?:\((\d+),(\d+)\)|:(\d+):(\d+)) ?[:-] ?error (TS\d+): (.*)$/gm)) {
    errors.push({ language: 'typescript', errorType: fm[6]!, message: fm[7]!.trim(), frames: [{ file: rel(fm[1]!), line: Number(fm[2] ?? fm[4]), column: Number(fm[3] ?? fm[5]), inProject: true }] })
  }

  // Go panics and compile errors
  for (const block of text.matchAll(/^panic: (.*)\n[\s\S]*?\n((?:.*\n\t.*\.go:\d+.*\n?)+)/gm)) {
    const frames: StackFrame[] = []
    for (const fm of block[2]!.matchAll(/^(\S.*)\n\t(\S+\.go):(\d+)/gm)) frames.push({ file: rel(fm[2]!), line: Number(fm[3]), function: fm[1]!.replace(/\(.*\)$/, ''), inProject: inProject(fm[2]!) })
    errors.push({ language: 'go', errorType: 'panic', message: block[1]!.trim(), frames })
  }
  for (const fm of text.matchAll(/^(\.?\/?[\w./-]+\.go):(\d+):(\d+): (.*)$/gm)) {
    errors.push({ language: 'go', errorType: 'compile', message: fm[4]!, frames: [{ file: rel(fm[1]!), line: Number(fm[2]), column: Number(fm[3]), inProject: true }] })
  }

  // Rust: "error[E0308]: mismatched types\n --> src/main.rs:4:5"
  for (const fm of text.matchAll(/^error(?:\[(E\d+)\])?: (.*)\n\s+--> ([^:\s]+):(\d+):(\d+)/gm)) {
    errors.push({ language: 'rust', errorType: fm[1] ?? 'error', message: fm[2]!, frames: [{ file: rel(fm[3]!), line: Number(fm[4]), column: Number(fm[5]), inProject: true }] })
  }

  // Java: "Exception in thread "main" java.lang.X: msg\n\tat pkg.Cls.method(File.java:10)"
  for (const block of text.matchAll(/(?:Exception in thread "[^"]+" )?([\w.$]+(?:Exception|Error)): ?(.*)\n((?:\s+at [\w.$<>]+\(.*\)\n?)+)/g)) {
    const frames: StackFrame[] = []
    for (const fm of block[3]!.matchAll(/at ([\w.$<>]+)\(([\w.]+):(\d+)\)/g)) frames.push({ file: fm[2]!, line: Number(fm[3]), function: fm[1], inProject: !fm[1]!.startsWith('java.') })
    if (!errors.some((e) => e.message === block[2]!.trim())) errors.push({ language: 'java', errorType: block[1]!, message: block[2]!.trim(), frames })
  }
  return errors
}

const HINTS: Array<{ re: RegExp; hint: string }> = [
  { re: /Cannot find module|MODULE_NOT_FOUND|ModuleNotFoundError|No module named/, hint: 'A dependency or import path is missing: check the import path and run the package manager install command.' },
  { re: /is not a function/, hint: 'A value used as a function is undefined or of the wrong type: check the import/export names and call site.' },
  { re: /Cannot read propert(y|ies) of (undefined|null)/, hint: 'An object is undefined/null at runtime: add a guard or fix the data flow that produces it.' },
  { re: /EADDRINUSE/, hint: 'The port is already in use: stop the other process or choose another port.' },
  { re: /ENOENT/, hint: 'A file or directory does not exist at the given path.' },
  { re: /EACCES|Permission denied/, hint: 'Permission problem: check file permissions or avoid privileged ports/paths.' },
  { re: /SyntaxError/, hint: 'Syntax error: inspect the reported line and the line before it for unbalanced brackets or quotes.' },
  { re: /TS2322|TS2345/, hint: 'Type mismatch: the value does not match the declared type; adjust the type or the value.' },
  { re: /TS2307/, hint: 'TypeScript cannot resolve a module: check the path, file extension (.js in ESM) and tsconfig paths.' },
  { re: /IndentationError/, hint: 'Python indentation is inconsistent: use spaces consistently.' },
  { re: /KeyError/, hint: 'A dictionary key is missing: use .get() or check the key exists.' },
  { re: /nil pointer dereference/, hint: 'A nil pointer is dereferenced: check initialization before use.' },
  { re: /timeout|timed out/i, hint: 'An operation timed out: check for hangs, unresolved promises, or slow external services.' },
]

export class DebuggingEngine {
  constructor(
    private readonly fs: FileSystemManager,
    private readonly policy: CommandPolicy,
  ) {}

  async buildContext(root: string, output: string, contextLines = 6): Promise<DebugContext[]> {
    const errors = parseErrorOutput(output, root)
    const results: DebugContext[] = []
    for (const error of errors.slice(0, 10)) {
      const snippets: DebugContext['snippets'] = []
      for (const frame of error.frames.filter((f) => f.inProject).slice(0, 4)) {
        try {
          const content = await this.fs.readText(root, frame.file)
          const lines = content.split('\n')
          const start = Math.max(1, frame.line - contextLines)
          const end = Math.min(lines.length, frame.line + contextLines)
          const code = lines
            .slice(start - 1, end)
            .map((l, i) => `${String(start + i).padStart(5)}${start + i === frame.line ? ' >' : '  '} ${l}`)
            .join('\n')
          snippets.push({ file: frame.file, line: frame.line, startLine: start, code })
        } catch {
          // frame file not readable inside the sandbox
        }
      }
      const full = `${error.errorType}: ${error.message}`
      results.push({ error, snippets, hints: HINTS.filter((h) => h.re.test(full) || h.re.test(output)).map((h) => h.hint) })
    }
    return results
  }

  async reproduce(root: string, command: string, timeoutMs = 120_000, signal?: AbortSignal) {
    const res = await runShell(command, { cwd: root, timeoutMs, signal }, this.policy)
    const output = `${res.stdout}\n${res.stderr}`
    return { exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs, output: output.slice(-50_000), contexts: await this.buildContext(root, output) }
  }

  static formatContexts(contexts: DebugContext[]): string {
    if (!contexts.length) return 'No recognizable errors or stack traces were found in the output.'
    return contexts
      .map((c, i) => {
        const parts = [`## Error ${i + 1}: ${c.error.errorType}: ${c.error.message} (${c.error.language})`]
        if (c.error.frames.length) parts.push('Stack:\n' + c.error.frames.slice(0, 10).map((f) => `  ${f.function ?? '<anonymous>'} — ${f.file}:${f.line}${f.inProject ? '' : ' (external)'}`).join('\n'))
        for (const s of c.snippets) parts.push(`${s.file}:${s.line}\n${s.code}`)
        if (c.hints.length) parts.push('Hints:\n' + c.hints.map((h) => `  - ${h}`).join('\n'))
        return parts.join('\n\n')
      })
      .join('\n\n')
  }
}
