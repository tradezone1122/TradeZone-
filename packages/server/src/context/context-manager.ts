/**
 * Module 06: Context Management
 *
 * Assembles what the model sees on each turn and keeps it inside budget:
 *  - system prompt composition: role prompt + project instructions (AGENTS.md,
 *    CLAUDE.md, project settings) + repository map + relevant memories +
 *    skill catalogue + environment facts;
 *  - token budgeting with a provider-neutral estimator;
 *  - compaction: when history exceeds the budget, older turns are summarized
 *    by the model (or, if unavailable, deterministically condensed), keeping
 *    tool_use/tool_result pairs intact and the most recent turns verbatim;
 *  - large tool results from old turns are elided first (cheap win).
 */
import type { ChatMessage, ContentBlock } from '../core/types.js'
import { estimateTokens, textOf } from '../core/types.js'
import type { FileSystemManager } from '../fs/file-system.js'
import type { MemoryService, ScopeFilter } from '../memory/memory-service.js'
import type { SkillsEngine } from '../skills/skills-engine.js'

export interface SystemPromptInput {
  rolePrompt: string
  agentName: string
  projectName?: string
  projectRoot?: string
  projectInstructions?: string
  repoMap?: string
  memoryQuery?: string
  memoryScopes?: ScopeFilter[]
  skills?: string[]
  extra?: string
}

export interface CompactionResult {
  messages: ChatMessage[]
  compacted: boolean
  removedMessages: number
  tokensBefore: number
  tokensAfter: number
}

export type Summarizer = (transcript: string) => Promise<string>

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.tradezone/instructions.md']

export class ContextManager {
  constructor(
    private readonly fs: FileSystemManager,
    private readonly memory: MemoryService,
    private readonly skills: SkillsEngine,
  ) {}

  async projectInstructions(root: string): Promise<string> {
    const parts: string[] = []
    for (const f of INSTRUCTION_FILES) {
      try {
        const text = await this.fs.readText(root, f)
        parts.push(`### ${f}\n${text.slice(0, 8000)}`)
      } catch {
        // file absent
      }
    }
    return parts.join('\n\n')
  }

  async buildSystemPrompt(input: SystemPromptInput): Promise<string> {
    const sections: string[] = [input.rolePrompt.trim()]
    const env = [`Agent name: ${input.agentName}`, `Current date: ${new Date().toISOString().slice(0, 10)}`]
    if (input.projectName) env.push(`Active project: ${input.projectName}`)
    if (input.projectRoot) env.push('File paths in tools are relative to the project root.')
    else env.push('No project is active: project file, git and command tools are unavailable.')
    sections.push(`## Environment\n${env.join('\n')}`)
    if (input.projectRoot) {
      const fromFiles = await this.projectInstructions(input.projectRoot)
      const instr = [input.projectInstructions, fromFiles].filter(Boolean).join('\n\n')
      if (instr) sections.push(`## Project instructions\n${instr}`)
    }
    if (input.repoMap) sections.push(`## Repository map (truncated)\n${input.repoMap.slice(0, 6000)}`)
    if (input.memoryQuery && input.memoryScopes?.length) {
      const mems = this.memory.search(input.memoryQuery, input.memoryScopes, 6)
      if (mems.length) sections.push(`## Relevant memories\n${mems.map((m) => `- (${m.scope}${m.kind !== 'fact' ? `/${m.kind}` : ''}) ${m.content.slice(0, 600)}`).join('\n')}`)
    }
    const catalogue = this.skills.catalogue(input.skills)
    if (catalogue) {
      const matched = input.memoryQuery ? this.skills.match(input.memoryQuery, 2, input.skills) : []
      sections.push(
        `## Skills\nLoad a skill's full instructions with the load_skill tool when it applies:\n${catalogue}` +
          (matched.length ? `\n\nLikely relevant now: ${matched.map((m) => m.skill.name).join(', ')}` : ''),
      )
    }
    if (input.extra) sections.push(input.extra)
    return sections.join('\n\n')
  }

  /** Replace bulky tool results in older turns with short placeholders. */
  elideOldToolResults(messages: ChatMessage[], keepRecent = 6, maxChars = 2000): ChatMessage[] {
    const cutoff = messages.length - keepRecent
    return messages.map((m, i) => {
      if (i >= cutoff || m.role !== 'user') return m
      let changed = false
      const content = m.content.map((b): ContentBlock => {
        if (b.type === 'tool_result' && b.content.length > maxChars) {
          changed = true
          return { ...b, content: `${b.content.slice(0, maxChars / 2)}\n… [older tool output elided: ${b.content.length} chars] …` }
        }
        return b
      })
      return changed ? { ...m, content } : m
    })
  }

  /**
   * Keep history within `budgetTokens`. Summarizes the oldest messages into a
   * single synthetic user message. The split point never separates a
   * tool_use from its tool_result.
   */
  async compact(messages: ChatMessage[], budgetTokens: number, summarize?: Summarizer, keepRecent = 8): Promise<CompactionResult> {
    const tokensBefore = estimateTokens(messages)
    let working = this.elideOldToolResults(messages, keepRecent)
    if (estimateTokens(working) <= budgetTokens || working.length <= keepRecent + 1) {
      return { messages: working, compacted: working !== messages && estimateTokens(working) < tokensBefore, removedMessages: 0, tokensBefore, tokensAfter: estimateTokens(working) }
    }
    let split = Math.max(1, working.length - keepRecent)
    // Move split so the kept tail starts with a user message that is not a tool_result continuation.
    while (split < working.length && (working[split]!.role !== 'user' || working[split]!.content.some((b) => b.type === 'tool_result'))) split++
    if (split >= working.length) split = Math.max(1, working.length - 2)
    const head = working.slice(0, split)
    const tail = working.slice(split)
    const transcript = head
      .map((m) =>
        m.content
          .map((b) => {
            if (b.type === 'text') return `${m.role.toUpperCase()}: ${b.text}`
            if (b.type === 'tool_use') return `${m.role.toUpperCase()} called ${b.name}(${JSON.stringify(b.input).slice(0, 400)})`
            if (b.type === 'tool_result') return `TOOL RESULT${b.is_error ? ' (error)' : ''}: ${b.content.slice(0, 800)}`
            return ''
          })
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n')
    let summary: string
    try {
      summary = summarize ? await summarize(transcript.slice(-120_000)) : deterministicSummary(head)
    } catch {
      summary = deterministicSummary(head)
    }
    working = [{ role: 'user', content: [{ type: 'text', text: `[Conversation summary of ${head.length} earlier messages]\n${summary}` }] }, ...tail]
    // Ensure alternation: if tail starts with a user message, merge into the summary message.
    if (working[1]?.role === 'user') {
      working = [{ role: 'user', content: [...working[0]!.content, ...working[1]!.content] }, ...working.slice(2)]
    }
    return { messages: working, compacted: true, removedMessages: head.length, tokensBefore, tokensAfter: estimateTokens(working) }
  }
}

function deterministicSummary(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = textOf(m.content).trim()
    if (text) lines.push(`- ${m.role}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`)
    for (const b of m.content) if (b.type === 'tool_use') lines.push(`- tool ${b.name} ${JSON.stringify(b.input).slice(0, 160)}`)
  }
  return lines.slice(-60).join('\n')
}
