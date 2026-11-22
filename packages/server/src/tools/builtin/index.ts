/**
 * Built-in tools available to agents. Each tool is a thin, validated adapter
 * over a platform engine (file system, editing, code intelligence, git,
 * testing, debugging, review, memory, messaging, tasks, skills, web).
 */
import { z } from 'zod'
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import type { ToolDefinition, ToolRegistry, ToolResult } from '../registry.js'
import { runShell, formatRunResult } from '../../terminal/process.js'
import { DebuggingEngine } from '../../debugging/debug-engine.js'

const ok = (content: string, data?: unknown): ToolResult => ({ content, data })
const err = (content: string): ToolResult => ({ content, isError: true })

function numbered(content: string, offset = 1, limit?: number): string {
  const lines = content.split('\n')
  const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined)
  return slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n')
}

// -------------------------------------------------------------- fs (read)
const readFile: ToolDefinition<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  description: 'Read a text file from the project. Returns numbered lines. Use offset/limit (1-based line numbers) for large files.',
  category: 'fs-read',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ path: z.string().describe('File path relative to the project root'), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(5000).optional() }),
  async handler(input, ctx) {
    const f = await ctx.services.fs.read(ctx.projectRoot!, input.path)
    if (f.binary) return err(`'${input.path}' is a binary file (${f.size} bytes).`)
    const total = f.content.split('\n').length
    const limit = input.limit ?? (total > 2000 ? 2000 : undefined)
    const header = `${f.path} (${total} lines${f.truncated ? ', truncated at 2 MB' : ''})${limit && total > (input.offset ?? 1) - 1 + limit ? ` — showing ${input.offset ?? 1}-${(input.offset ?? 1) + limit - 1}` : ''}`
    return ok(`${header}\n${numbered(f.content, input.offset ?? 1, limit)}`)
  },
}

const listDir: ToolDefinition<{ path?: string; depth?: number }> = {
  name: 'list_dir',
  description: 'List files and directories as a tree (ignores node_modules, .git, build output).',
  category: 'fs-read',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ path: z.string().optional().describe('Directory relative to project root (default ".")'), depth: z.number().int().min(1).max(6).optional() }),
  async handler(input, ctx) {
    const tree = await ctx.services.fs.tree(ctx.projectRoot!, input.path ?? '.', input.depth ?? 2)
    const lines: string[] = []
    const walk = (n: typeof tree, indent: string) => {
      for (const c of n.children ?? []) {
        lines.push(`${indent}${c.type === 'dir' ? c.name + '/' : `${c.name}${c.size !== undefined ? ` (${c.size} B)` : ''}`}`)
        if (c.children) walk(c, indent + '  ')
      }
    }
    walk(tree, '')
    return ok(lines.length ? lines.slice(0, 1500).join('\n') : '(empty directory)', tree)
  },
}

const globTool: ToolDefinition<{ pattern: string }> = {
  name: 'glob',
  description: 'Find files by glob pattern, e.g. "src/**/*.ts" or "*.md".',
  category: 'fs-read',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ pattern: z.string().min(1) }),
  async handler(input, ctx) {
    const files = await ctx.services.fs.glob(ctx.projectRoot!, input.pattern, 1000)
    return ok(files.length ? files.join('\n') : 'No files match.', files)
  },
}

const grep: ToolDefinition<{ query: string; regex?: boolean; caseSensitive?: boolean; include?: string; limit?: number }> = {
  name: 'grep',
  description: 'Search file contents. Literal by default; set regex=true for regular expressions. Optional include glob filters files.',
  category: 'fs-read',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ query: z.string().min(1), regex: z.boolean().optional(), caseSensitive: z.boolean().optional(), include: z.string().optional(), limit: z.number().int().min(1).max(2000).optional() }),
  async handler(input, ctx) {
    const matches = await ctx.services.fs.search(ctx.projectRoot!, input.query, { regex: input.regex, caseSensitive: input.caseSensitive, include: input.include, limit: input.limit ?? 300 })
    return ok(matches.length ? matches.map((m) => `${m.path}:${m.line}: ${m.text.trim()}`).join('\n') : 'No matches.', matches)
  },
}

// ------------------------------------------------------------- fs (write)
const writeFile: ToolDefinition<{ path: string; content: string }> = {
  name: 'write_file',
  description: 'Create a new file or completely overwrite an existing file. Prefer edit_file for changes to existing files.',
  category: 'fs-write',
  permission: 'write',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  async handler(input, ctx) {
    const r = await ctx.services.editing.writeFile(ctx.projectRoot!, input.path, input.content)
    ctx.services.bus.publish(`project:${ctx.projectId}`, 'file.changed', { path: r.path, by: ctx.agentName })
    return ok(`${r.created ? 'Created' : 'Overwrote'} ${r.path} (+${r.stats.additions} -${r.stats.deletions}).`, r)
  },
}

const editFile: ToolDefinition<{ path: string; edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }> }> = {
  name: 'edit_file',
  description: 'Edit an existing file by exact string replacement. Each oldString must match the file exactly (including whitespace) and be unique unless replaceAll is true. All edits apply atomically.',
  category: 'fs-write',
  permission: 'write',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({
    path: z.string().min(1),
    edits: z.array(z.object({ oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().optional() })).min(1).max(50),
  }),
  async handler(input, ctx) {
    const r = await ctx.services.editing.editFile(ctx.projectRoot!, input.path, input.edits)
    ctx.services.bus.publish(`project:${ctx.projectId}`, 'file.changed', { path: r.path, by: ctx.agentName })
    return ok(`Edited ${r.path} (+${r.stats.additions} -${r.stats.deletions}).\n${r.diff.slice(0, 4000)}`, r)
  },
}

const applyPatch: ToolDefinition<{ patch: string }> = {
  name: 'apply_patch',
  description: 'Apply a unified diff (one or more files; /dev/null for creations/deletions). Validated before any file is written.',
  category: 'fs-write',
  permission: 'write',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ patch: z.string().min(1) }),
  async handler(input, ctx) {
    const results = await ctx.services.editing.applyPatch(ctx.projectRoot!, input.patch)
    for (const r of results) ctx.services.bus.publish(`project:${ctx.projectId}`, 'file.changed', { path: r.path, by: ctx.agentName })
    return ok(results.map((r) => `${r.path}: +${r.stats.additions} -${r.stats.deletions}${r.created ? ' (created)' : ''}`).join('\n'), results)
  },
}

const deleteFile: ToolDefinition<{ path: string }> = {
  name: 'delete_file',
  description: 'Delete a file or directory (recursively) inside the project.',
  category: 'fs-write',
  permission: 'write',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ path: z.string().min(1) }),
  async handler(input, ctx) {
    await ctx.services.fs.remove(ctx.projectRoot!, input.path)
    ctx.services.bus.publish(`project:${ctx.projectId}`, 'file.changed', { path: input.path, deleted: true, by: ctx.agentName })
    return ok(`Deleted ${input.path}.`)
  },
}

const moveFile: ToolDefinition<{ from: string; to: string }> = {
  name: 'move_file',
  description: 'Move or rename a file or directory inside the project.',
  category: 'fs-write',
  permission: 'write',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  async handler(input, ctx) {
    await ctx.services.fs.rename(ctx.projectRoot!, input.from, input.to)
    ctx.services.bus.publish(`project:${ctx.projectId}`, 'file.changed', { path: input.to, from: input.from, by: ctx.agentName })
    return ok(`Moved ${input.from} → ${input.to}.`)
  },
}

// ------------------------------------------------------------------ code
const searchSymbols: ToolDefinition<{ query: string; kind?: string; limit?: number }> = {
  name: 'search_symbols',
  description: 'Find functions, classes, methods, interfaces and types by name across the project (AST-based for JS/TS).',
  category: 'code',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ query: z.string().min(1), kind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'variable', 'struct', 'trait', 'module', 'constant', 'property']).optional(), limit: z.number().int().min(1).max(200).optional() }),
  async handler(input, ctx) {
    const index = ctx.services.symbolIndex(ctx.projectRoot!)
    await index.refresh()
    const found = index.search(input.query, { kind: input.kind as never, limit: input.limit ?? 40 })
    return ok(found.length ? found.map((s) => `${s.kind} ${s.container ? s.container + '.' : ''}${s.name} — ${s.file}:${s.line}${s.exported ? ' (exported)' : ''}${s.signature ? `\n    ${s.signature}` : ''}`).join('\n') : 'No symbols found.', found)
  },
}

const fileOutline: ToolDefinition<{ path: string }> = {
  name: 'file_outline',
  description: 'Show the structure of a source file: imports, exports and symbols with line ranges.',
  category: 'code',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ path: z.string().min(1) }),
  async handler(input, ctx) {
    const { analyzeSource } = await import('../../code/symbols.js')
    const content = await ctx.services.fs.readText(ctx.projectRoot!, input.path)
    const a = analyzeSource(input.path, content)
    const lines = [`${a.file} (${a.language}, ${a.lines} lines)`, `imports: ${a.imports.join(', ') || '-'}`, `exports: ${a.exports.join(', ') || '-'}`, ...a.symbols.map((s) => `  ${s.line}-${s.endLine} ${s.kind} ${s.container ? s.container + '.' : ''}${s.name}`)]
    return ok(lines.join('\n'), a)
  },
}

const findReferences: ToolDefinition<{ symbol: string; include?: string }> = {
  name: 'find_references',
  description: 'Find usages of an identifier (whole-word match) across the project.',
  category: 'code',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ symbol: z.string().regex(/^[\w$]+$/), include: z.string().optional() }),
  async handler(input, ctx) {
    const matches = await ctx.services.fs.search(ctx.projectRoot!, `\\b${input.symbol.replace(/\$/g, '\\$')}\\b`, { regex: true, caseSensitive: true, include: input.include, limit: 500 })
    return ok(matches.length ? matches.map((m) => `${m.path}:${m.line}: ${m.text.trim()}`).join('\n') : 'No references found.', matches)
  },
}

const analyzeRepo: ToolDefinition<Record<string, never>> = {
  name: 'analyze_repo',
  description: 'Analyze the project: languages, frameworks, entry points, test/build commands, and a repository map of files with key symbols.',
  category: 'code',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({}),
  async handler(_input, ctx) {
    const a = await ctx.services.repo.analyze(ctx.projectRoot!, ctx.services.symbolIndex(ctx.projectRoot!))
    const summary = [
      `Files: ${a.fileCount}, lines: ${a.totalLines}, symbols: ${a.symbolCount}`,
      `Languages: ${a.languages.slice(0, 8).map((l) => `${l.language} ${l.percent}%`).join(', ')}`,
      `Frameworks: ${a.frameworks.join(', ') || '-'}`,
      `Package managers: ${a.packageManagers.join(', ') || '-'}`,
      `Entry points: ${a.entryPoints.join(', ') || '-'}`,
      `Test command: ${a.testCommand ?? '-'}  Build command: ${a.buildCommand ?? '-'}`,
      `Instructions files: ${a.instructionsFiles.join(', ') || '-'}`,
      '',
      'Repository map:',
      a.repoMap,
    ].join('\n')
    return ok(summary, a)
  },
}

// ------------------------------------------------------------------- git
const gitStatus: ToolDefinition<Record<string, never>> = {
  name: 'git_status',
  description: 'Show the git branch, upstream tracking and changed/untracked files.',
  category: 'git',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({}),
  async handler(_i, ctx) {
    const s = await ctx.services.git.status(ctx.projectRoot!)
    if (!s.isRepo) return ok('Not a git repository.', s)
    const lines = [`On branch ${s.branch ?? '(detached)'}${s.upstream ? ` tracking ${s.upstream} (ahead ${s.ahead}, behind ${s.behind})` : ''}`]
    for (const f of s.files) lines.push(`${f.untracked ? '??' : `${f.index}${f.worktree}`} ${f.path}${f.origPath ? ` (from ${f.origPath})` : ''}`)
    if (!s.files.length) lines.push('Working tree clean.')
    return ok(lines.join('\n'), s)
  },
}

const gitDiff: ToolDefinition<{ staged?: boolean; path?: string; ref?: string }> = {
  name: 'git_diff',
  description: 'Show the diff of uncommitted changes (or staged changes, or against a ref).',
  category: 'git',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ staged: z.boolean().optional(), path: z.string().optional(), ref: z.string().optional() }),
  async handler(input, ctx) {
    const d = await ctx.services.git.diff(ctx.projectRoot!, input)
    return ok(d || 'No changes.')
  },
}

const gitLog: ToolDefinition<{ limit?: number }> = {
  name: 'git_log',
  description: 'Show recent commits.',
  category: 'git',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  async handler(input, ctx) {
    const log = await ctx.services.git.log(ctx.projectRoot!, input.limit ?? 20)
    return ok(log.length ? log.map((c) => `${c.shortHash} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`).join('\n') : 'No commits.', log)
  },
}

const gitCommit: ToolDefinition<{ message: string; paths?: string[]; all?: boolean }> = {
  name: 'git_commit',
  description: 'Stage the given paths (or all changes with all=true) and commit. Commits containing secrets are blocked.',
  category: 'git',
  permission: 'write',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ message: z.string().min(3), paths: z.array(z.string()).optional(), all: z.boolean().optional() }),
  async handler(input, ctx) {
    if (input.paths?.length) await ctx.services.git.stage(ctx.projectRoot!, input.paths)
    const c = await ctx.services.git.commit(ctx.projectRoot!, input.message, { all: input.all || !input.paths?.length, author: { name: `TradeZone ${ctx.agentName ?? 'agent'}`, email: 'agent@tradezone.local' } })
    ctx.services.bus.publish(`project:${ctx.projectId}`, 'git.changed', { commit: c.shortHash })
    return ok(`Committed ${c.shortHash}: ${c.subject}`, c)
  },
}

const gitCheckout: ToolDefinition<{ branch: string; create?: boolean }> = {
  name: 'git_checkout',
  description: 'Switch to a branch, optionally creating it.',
  category: 'git',
  permission: 'write',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ branch: z.string().min(1), create: z.boolean().optional() }),
  async handler(input, ctx) {
    await ctx.services.git.checkout(ctx.projectRoot!, input.branch, input.create)
    ctx.services.bus.publish(`project:${ctx.projectId}`, 'git.changed', { branch: input.branch })
    return ok(`Now on branch ${input.branch}.`)
  },
}

const gitPush: ToolDefinition<{ remote?: string; branch?: string }> = {
  name: 'git_push',
  description: 'Push the current branch to a remote.',
  category: 'git',
  permission: 'execute',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ remote: z.string().optional(), branch: z.string().optional() }),
  async handler(input, ctx) {
    return ok(await ctx.services.git.push(ctx.projectRoot!, input.remote, input.branch))
  },
}

// --------------------------------------------------------------- execute
const runCommand: ToolDefinition<{ command: string; timeoutSeconds?: number }> = {
  name: 'run_command',
  description: 'Run a shell command in the project directory (non-interactive, with timeout). Dangerous commands are blocked by the security policy. Platform secrets are not present in the environment.',
  category: 'exec',
  permission: 'execute',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ command: z.string().min(1).max(10_000), timeoutSeconds: z.number().int().min(1).max(1800).optional() }),
  async handler(input, ctx) {
    const res = await runShell(input.command, { cwd: ctx.projectRoot!, timeoutMs: (input.timeoutSeconds ?? Math.round(ctx.services.config.commandTimeoutMs / 1000)) * 1000, signal: ctx.signal, onOutput: (chunk) => ctx.emit?.('tool.output', { chunk }) }, ctx.services.commandPolicy)
    return { content: formatRunResult(res), isError: res.exitCode !== 0, data: { exitCode: res.exitCode, durationMs: res.durationMs } }
  },
}

const runTests: ToolDefinition<{ command?: string; filter?: string }> = {
  name: 'run_tests',
  description: "Run the project's test suite (auto-detected or a given command) and return structured results with failures.",
  category: 'exec',
  permission: 'execute',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ command: z.string().optional(), filter: z.string().optional().describe('Test name/file filter appended to the command') }),
  async handler(input, ctx) {
    const project = ctx.projectId ? ctx.services.projects.get(ctx.projectId) : null
    const r = await ctx.services.testing.run(ctx.projectId!, ctx.projectRoot!, { command: input.command ?? project?.settings.testCommand, filter: input.filter, signal: ctx.signal })
    const head = `Tests ${r.status.toUpperCase()}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped (${r.durationMs} ms) — ${r.command}`
    const failures = r.failures.length ? '\nFailures:\n' + r.failures.map((f) => `- ${f.name}${f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : ''}${f.message ? `: ${f.message}` : ''}`).join('\n') : ''
    return { content: `${head}${failures}\n\nOutput (tail):\n${r.output.slice(-6000)}`, isError: r.status !== 'passed', data: { id: r.id, status: r.status, passed: r.passed, failed: r.failed } }
  },
}

const debugError: ToolDefinition<{ command?: string; output?: string }> = {
  name: 'debug_error',
  description: 'Reproduce a failure by running a command (or analyze given error output): parses stack traces, maps frames to project files and returns source snippets and hints.',
  category: 'exec',
  permission: 'execute',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ command: z.string().optional(), output: z.string().optional() }).refine((v) => v.command || v.output, 'Provide command or output'),
  async handler(input, ctx) {
    if (input.command) {
      const r = await ctx.services.debugging.reproduce(ctx.projectRoot!, input.command, 180_000, ctx.signal)
      return ok(`Command exited with ${r.exitCode}${r.timedOut ? ' (timed out)' : ''} in ${r.durationMs} ms.\n\n${DebuggingEngine.formatContexts(r.contexts)}\n\nOutput (tail):\n${r.output.slice(-4000)}`, r.contexts)
    }
    const contexts = await ctx.services.debugging.buildContext(ctx.projectRoot!, input.output!)
    return ok(DebuggingEngine.formatContexts(contexts), contexts)
  },
}

const reviewCode: ToolDefinition<{ target?: 'diff' | 'staged' | 'files'; files?: string[]; ai?: boolean }> = {
  name: 'review_code',
  description: 'Run the code review engine on uncommitted changes, staged changes, or specific files. Returns scored findings (static analysis, optionally AI).',
  category: 'code',
  permission: 'read',
  source: 'builtin',
  requiresProject: true,
  schema: z.object({ target: z.enum(['diff', 'staged', 'files']).optional(), files: z.array(z.string()).optional(), ai: z.boolean().optional() }),
  async handler(input, ctx) {
    const r = await ctx.services.review.review(ctx.projectId!, ctx.projectRoot!, { target: input.target, files: input.files, ai: input.ai ?? false, userId: ctx.userId, signal: ctx.signal })
    return ok(`${r.summary}\n\n${r.findings.slice(0, 80).map((f) => `[${f.severity}] ${f.file}${f.line ? ':' + f.line : ''} ${f.rule}: ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ''}`).join('\n')}`, { id: r.id, score: r.score })
  },
}

// ---------------------------------------------------------------- memory
const memorySave: ToolDefinition<{ content: string; scope?: 'project' | 'agent' | 'user' | 'global'; tags?: string[]; importance?: number; kind?: string }> = {
  name: 'memory_save',
  description: 'Save a durable memory (fact, decision, preference, lesson) for future runs. Scope defaults to the project if one is active, else the agent.',
  category: 'memory',
  permission: 'read',
  source: 'builtin',
  schema: z.object({ content: z.string().min(3).max(5000), scope: z.enum(['project', 'agent', 'user', 'global']).optional(), tags: z.array(z.string()).max(10).optional(), importance: z.number().min(0).max(1).optional(), kind: z.enum(['fact', 'decision', 'preference', 'lesson', 'todo']).optional() }),
  async handler(input, ctx) {
    const scope = input.scope ?? (ctx.projectId ? 'project' : 'agent')
    const scopeId = scope === 'project' ? ctx.projectId : scope === 'agent' ? ctx.agentName : scope === 'user' ? ctx.userId : null
    if (scope !== 'global' && !scopeId) return err(`Cannot save to scope '${scope}' without an active ${scope}.`)
    const m = ctx.services.memory.add({ scope, scopeId, content: input.content, tags: input.tags, importance: input.importance, kind: input.kind, source: ctx.runId ? `run:${ctx.runId}` : undefined, createdBy: ctx.agentName })
    return ok(`Saved memory ${m.id} (${scope}).`, m)
  },
}

const memorySearch: ToolDefinition<{ query: string; limit?: number }> = {
  name: 'memory_search',
  description: 'Search long-term memory relevant to a query across project, agent, user and global scopes.',
  category: 'memory',
  permission: 'read',
  source: 'builtin',
  schema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(30).optional() }),
  async handler(input, ctx) {
    const scopes: Array<{ scope: 'global' | 'user' | 'project' | 'agent'; scopeId?: string | null }> = [{ scope: 'global' }]
    if (ctx.projectId) scopes.push({ scope: 'project', scopeId: ctx.projectId })
    if (ctx.agentName) scopes.push({ scope: 'agent', scopeId: ctx.agentName })
    if (ctx.userId) scopes.push({ scope: 'user', scopeId: ctx.userId })
    const found = ctx.services.memory.search(input.query, scopes, input.limit ?? 8)
    return ok(found.length ? found.map((m) => `- [${m.scope}/${m.kind} score ${m.score}] ${m.content}`).join('\n') : 'No relevant memories.', found)
  },
}

// ------------------------------------------------------- collaboration
const delegateTask: ToolDefinition<{ agent: string; task: string; context?: string }> = {
  name: 'delegate_task',
  description: 'Delegate a sub-task to another agent (e.g. coder, tester, reviewer) and wait for its result. The sub-agent works in the same project.',
  category: 'agents',
  permission: 'execute',
  source: 'builtin',
  schema: z.object({ agent: z.string().min(1), task: z.string().min(5), context: z.string().optional() }),
  async handler(input, ctx) {
    const agent = ctx.services.agents.get(input.agent)
    if (!agent.enabled) return err(`Agent '${agent.name}' is disabled.`)
    if (agent.name === ctx.agentName) return err('An agent cannot delegate to itself.')
    const project = ctx.projectId ? ctx.services.projects.get(ctx.projectId) : null
    ctx.emit?.('delegation.started', { agent: agent.name, task: input.task })
    const outcome = await ctx.services.runner.run({
      agent,
      input: input.task,
      userId: ctx.userId,
      project: project ? { id: project.id, name: project.name, rootPath: project.rootPath, instructions: project.settings.instructions } : undefined,
      parentRunId: ctx.runId,
      teamRunId: ctx.teamRunId,
      extraContext: input.context ? `## Context from ${ctx.agentName}\n${input.context}` : `## Delegation\nThis task was delegated by agent ${ctx.agentName}.`,
      depth: (ctx.depth ?? 0) + 1,
      signal: ctx.signal,
    })
    ctx.emit?.('delegation.finished', { agent: agent.name, runId: outcome.run.id, status: outcome.run.status })
    return { content: `Sub-agent ${agent.name} ${outcome.run.status} (run ${outcome.run.id}):\n${outcome.run.output ?? outcome.run.error ?? ''}`, isError: outcome.run.status !== 'completed', data: { runId: outcome.run.id } }
  },
}

const sendMessage: ToolDefinition<{ to?: string; content: string }> = {
  name: 'send_message',
  description: 'Send a message to another agent (by name) or, without "to", to your whole team.',
  category: 'agents',
  permission: 'read',
  source: 'builtin',
  schema: z.object({ to: z.string().optional(), content: z.string().min(1).max(20_000) }),
  async handler(input, ctx) {
    const m = ctx.services.messaging.send({ from: ctx.agentName ?? 'agent', to: input.to ?? null, teamRunId: ctx.teamRunId ?? null, content: input.content })
    return ok(`Message ${m.id} sent to ${input.to ?? 'team'}.`)
  },
}

const readMessages: ToolDefinition<Record<string, never>> = {
  name: 'read_messages',
  description: 'Read unread messages sent to you by other agents (and team broadcasts).',
  category: 'agents',
  permission: 'read',
  source: 'builtin',
  schema: z.object({}),
  async handler(_i, ctx) {
    const msgs = ctx.services.messaging.inbox(ctx.agentName ?? 'agent', { teamRunId: ctx.teamRunId })
    return ok(msgs.length ? msgs.map((m) => `[${m.createdAt}] ${m.fromAgent}${m.toAgent ? ' → you' : ' → team'}: ${m.content}`).join('\n\n') : 'No new messages.')
  },
}

const createTask: ToolDefinition<{ title: string; description?: string; assignee?: string; dependsOn?: string[]; autoRun?: boolean; priority?: number }> = {
  name: 'create_task',
  description: 'Create a task on the project task board, optionally assigned to an agent and set to run automatically when its dependencies complete.',
  category: 'agents',
  permission: 'write',
  source: 'builtin',
  schema: z.object({ title: z.string().min(3), description: z.string().optional(), assignee: z.string().optional(), dependsOn: z.array(z.string()).optional(), autoRun: z.boolean().optional(), priority: z.number().int().min(-10).max(10).optional() }),
  async handler(input, ctx) {
    const t = ctx.services.tasks.create({ ...input, projectId: ctx.projectId ?? null }, ctx.userId)
    return ok(`Created task ${t.id} (${t.status}).`, t)
  },
}

const listTasks: ToolDefinition<{ status?: string }> = {
  name: 'list_tasks',
  description: 'List tasks on the project task board.',
  category: 'agents',
  permission: 'read',
  source: 'builtin',
  schema: z.object({ status: z.enum(['pending', 'ready', 'running', 'completed', 'failed', 'cancelled', 'blocked']).optional() }),
  async handler(input, ctx) {
    const tasks = ctx.services.tasks.list({ projectId: ctx.projectId, status: input.status as never, limit: 100 })
    return ok(tasks.length ? tasks.map((t) => `${t.id} [${t.status}] p${t.priority} ${t.title}`).join('\n') : 'No tasks.', tasks)
  },
}

const loadSkill: ToolDefinition<{ name: string }> = {
  name: 'load_skill',
  description: 'Load the full instructions of a skill listed in your system prompt.',
  category: 'skills',
  permission: 'read',
  source: 'builtin',
  schema: z.object({ name: z.string().min(1) }),
  async handler(input, ctx) {
    const s = ctx.services.skills.get(input.name)
    if (!s.enabled) return err(`Skill '${s.name}' is disabled.`)
    return ok(`# Skill: ${s.name}\n${s.description}\n\n${s.body}`)
  },
}

// ------------------------------------------------------------------- web
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number]
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const v = ip.toLowerCase()
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.')
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

const webFetch: ToolDefinition<{ url: string; maxChars?: number }> = {
  name: 'web_fetch',
  description: 'Fetch a public web page or API (GET) and return its text. Private/internal network addresses are blocked.',
  category: 'web',
  permission: 'network',
  source: 'builtin',
  schema: z.object({ url: z.string().url(), maxChars: z.number().int().min(500).max(200_000).optional() }),
  async handler(input, ctx) {
    if (!ctx.services.settings.get<boolean>('tools.webFetchEnabled')) return err('web_fetch is disabled by the administrator.')
    const url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol)) return err('Only http(s) URLs are allowed.')
    const allow = ctx.services.settings.get<string[]>('tools.webFetchAllowlist')
    if (allow.length && !allow.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return err(`Host ${url.hostname} is not in the allow-list.`)
    const addrs = await lookup(url.hostname, { all: true }).catch(() => [])
    if (!addrs.length) return err(`Cannot resolve ${url.hostname}.`)
    if (addrs.some((a) => isPrivateAddress(a.address))) return err('Fetching private or internal network addresses is not allowed.')
    const res = await fetch(url, { signal: ctx.signal, redirect: 'follow', headers: { 'user-agent': 'TradeZone-AI-Platform/1.0 (+web_fetch)', accept: 'text/html,application/json,text/plain,*/*' } })
    const type = res.headers.get('content-type') ?? ''
    const body = await res.text()
    const text = type.includes('html') ? htmlToText(body) : body
    const max = input.maxChars ?? 40_000
    return { content: `HTTP ${res.status} ${type}\n\n${text.slice(0, max)}${text.length > max ? `\n… [${text.length - max} more characters]` : ''}`, isError: !res.ok }
  },
}

export const BUILTIN_TOOLS: ToolDefinition<any>[] = [
  readFile, listDir, globTool, grep,
  writeFile, editFile, applyPatch, deleteFile, moveFile,
  searchSymbols, fileOutline, findReferences, analyzeRepo, reviewCode,
  gitStatus, gitDiff, gitLog, gitCommit, gitCheckout, gitPush,
  runCommand, runTests, debugError,
  memorySave, memorySearch,
  delegateTask, sendMessage, readMessages, createTask, listTasks,
  loadSkill, webFetch,
]

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const t of BUILTIN_TOOLS) registry.register(t)
}
