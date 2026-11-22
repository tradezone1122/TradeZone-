/**
 * Composition root: constructs every module, wires dependencies, seeds
 * built-in data and exposes the service container used by the API server,
 * WebSocket server, tools and CLI.
 */
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import type { AppConfig } from './config/index.js'
import { Database } from './db/database.js'
import { EventBus } from './events/bus.js'
import { Logger, logHub, type LogLevel, LEVEL_ORDER } from './logging/logger.js'
import { MetricsRegistry, createPlatformMetrics, type PlatformMetrics } from './monitoring/metrics.js'
import { CommandPolicy, SecretBox } from './security/sandbox.js'
import { AuthService } from './auth/auth-service.js'
import { ProjectAccessControl } from './authz/rbac.js'
import { ProviderManager } from './providers/manager.js'
import { AIRouter } from './router/ai-router.js'
import { ToolRegistry } from './tools/registry.js'
import { ToolExecutor } from './tools/executor.js'
import { ApprovalService } from './tools/approvals.js'
import { registerBuiltinTools } from './tools/builtin/index.js'
import { AgentService } from './agents/agent-service.js'
import { AgentRunner } from './agents/runner.js'
import { ConversationService } from './agents/conversations.js'
import { Orchestrator } from './orchestrator/orchestrator.js'
import { AgentMessaging } from './comms/agent-messaging.js'
import { MemoryService } from './memory/memory-service.js'
import { ContextManager } from './context/context-manager.js'
import { PromptEngine } from './prompts/prompt-engine.js'
import { SkillsEngine } from './skills/skills-engine.js'
import { PluginManager } from './plugins/plugin-manager.js'
import { McpManager } from './mcp/mcp-manager.js'
import { ProjectService } from './projects/project-service.js'
import { FileSystemManager } from './fs/file-system.js'
import { GitService } from './git/git-service.js'
import { CodeEditingEngine } from './code/editing.js'
import { CodeGenerationEngine } from './code/generation.js'
import { SymbolIndex } from './code/symbols.js'
import { RepositoryAnalyzer } from './repo/analyzer.js'
import { Planner } from './planning/planner.js'
import { TaskService } from './tasks/task-service.js'
import { TerminalManager } from './terminal/terminal-manager.js'
import { TestingEngine } from './testing/test-engine.js'
import { DebuggingEngine } from './debugging/debug-engine.js'
import { CodeReviewEngine } from './review/review-engine.js'
import { DeployService } from './deploy/deploy-service.js'
import { SettingsService, AuditLog } from './core/settings.js'
import { now } from './db/database.js'

export interface PlatformServices {
  config: AppConfig
  db: Database
  bus: EventBus
  log: Logger
  metricsRegistry: MetricsRegistry
  metrics: PlatformMetrics
  secretBox: SecretBox
  commandPolicy: CommandPolicy
  auth: AuthService
  projectAccess: ProjectAccessControl
  providers: ProviderManager
  router: AIRouter
  registry: ToolRegistry
  executor: ToolExecutor
  approvals: ApprovalService
  agents: AgentService
  runner: AgentRunner
  conversations: ConversationService
  orchestrator: Orchestrator
  messaging: AgentMessaging
  memory: MemoryService
  context: ContextManager
  prompts: PromptEngine
  skills: SkillsEngine
  plugins: PluginManager
  mcp: McpManager
  projects: ProjectService
  fs: FileSystemManager
  git: GitService
  editing: CodeEditingEngine
  codegen: CodeGenerationEngine
  repo: RepositoryAnalyzer
  planner: Planner
  tasks: TaskService
  terminals: TerminalManager
  testing: TestingEngine
  debugging: DebuggingEngine
  review: CodeReviewEngine
  deploy: DeployService
  settings: SettingsService
  audit: AuditLog
  symbolIndex(root: string): SymbolIndex
  startedAt: string
}

export interface Platform extends PlatformServices {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createPlatform(config: AppConfig): Platform {
  mkdirSync(config.dataDir, { recursive: true })
  logHub.level = config.logLevel
  if (config.env === 'test') logHub.stdout = false
  const log = new Logger('platform')
  const db = new Database(config.databasePath)
  const applied = db.migrate()
  if (applied) log.info('Database migrated', { migrations: applied })

  // Persist warnings and errors for the admin log viewer.
  logHub.addSink((r) => {
    if (LEVEL_ORDER[r.level as LogLevel] >= LEVEL_ORDER.warn) {
      try {
        db.insert('logs', { level: r.level, module: r.module ?? null, msg: r.msg, context: r.context ? JSON.stringify(r.context).slice(0, 10_000) : null, created_at: r.time })
      } catch {
        /* database closed */
      }
    }
  })

  const bus = new EventBus()
  logHub.addSink((r) => bus.publish('system:logs', 'log', r))
  const metricsRegistry = new MetricsRegistry()
  const metrics = createPlatformMetrics(metricsRegistry)
  const secretBox = new SecretBox(config.secretKey)
  const settings = new SettingsService(db)
  const extraDeny = settings.get<string[]>('security.commandDenyPatterns').map((p) => new RegExp(p))
  const commandPolicy = new CommandPolicy({ allowUnsafe: config.allowUnsafeCommands, extraDeny })
  const audit = new AuditLog(db)
  const auth = new AuthService(db, config.secretKey, config.jwtTtlSeconds)
  const projectAccess = new ProjectAccessControl(db)
  const providers = new ProviderManager(db, secretBox, log.child('providers'))
  const router = new AIRouter(db, providers, metrics, log.child('router'), config.defaultModel)
  const registry = new ToolRegistry()
  const approvals = new ApprovalService(db, bus)
  const executor = new ToolExecutor(registry, approvals, db, metrics, log.child('tools'))
  const fs = new FileSystemManager()
  const git = new GitService()
  const editing = new CodeEditingEngine(fs)
  const memory = new MemoryService(db)
  const skills = new SkillsEngine(db)
  const prompts = new PromptEngine(db)
  const context = new ContextManager(fs, memory, skills)
  const agents = new AgentService(db)
  const messaging = new AgentMessaging(db, bus)
  const repo = new RepositoryAnalyzer(fs)
  const planner = new Planner(router)
  const projects = new ProjectService(db, config.workspacesDir, git)
  const conversations = new ConversationService(db)
  const testing = new TestingEngine(db, commandPolicy, bus)
  const debugging = new DebuggingEngine(fs, commandPolicy)
  const review = new CodeReviewEngine(db, fs, git, router)
  const codegen = new CodeGenerationEngine(router, fs, editing)
  const deploy = new DeployService(db, bus, commandPolicy, path.join(config.dataDir, 'deployments'))
  const terminals = new TerminalManager(bus, metrics, config.maxTerminalSessions)
  const mcp = new McpManager(db, secretBox, registry, bus, log.child('mcp'))
  const plugins = new PluginManager(db, path.join(config.dataDir, 'plugins'), registry, bus, prompts, skills, agents, log.child('plugins'))

  const indexes = new Map<string, SymbolIndex>()
  const symbolIndex = (root: string) => {
    let idx = indexes.get(root)
    if (!idx) {
      idx = new SymbolIndex(fs, root)
      indexes.set(root, idx)
      if (indexes.size > 50) indexes.delete(indexes.keys().next().value!)
    }
    return idx
  }

  // eslint-disable-next-line prefer-const
  let services: PlatformServices
  const runner = new AgentRunner({
    db,
    bus,
    router,
    registry,
    executor,
    context,
    metrics,
    log: log.child('runtime'),
    services: () => services,
    maxConcurrentRuns: config.maxConcurrentRuns,
    contextBudgetTokens: settings.get<number>('agents.contextBudgetTokens'),
  })
  const orchestrator = new Orchestrator({
    db,
    bus,
    runner,
    agents,
    router,
    planner,
    messaging,
    registry,
    executor,
    log: log.child('orchestrator'),
    services: () => services,
    repoContext: async (root) => (await repo.analyze(root, symbolIndex(root))).repoMap,
  })
  const tasks = new TaskService(db, bus, runner, agents, metrics, log.child('tasks'), (projectId) => {
    try {
      const p = projects.get(projectId)
      return { id: p.id, name: p.name, rootPath: p.rootPath, instructions: p.settings.instructions }
    } catch {
      return null
    }
  })

  metrics.wsConnections.set(0)
  metricsRegistry.gauge('tz_process_uptime_seconds', 'Process uptime in seconds').collect(() => Math.round(process.uptime()))
  metricsRegistry.gauge('tz_process_resident_memory_bytes', 'Resident memory in bytes').collect(() => process.memoryUsage().rss)
  metricsRegistry.gauge('tz_db_size_bytes', 'Database size in bytes').collect(() => db.sizeBytes())
  metricsRegistry.gauge('tz_tools_registered', 'Registered tools').collect(() => registry.list().length)
  metricsRegistry.gauge('tz_agent_runs_queued', 'Agent runs waiting for a slot').collect(() => runner.queuedCount)

  registerBuiltinTools(registry)
  const seeded = { agents: agents.seed(), skills: skills.seed(), prompts: prompts.seed(), providers: providers.seedFromEnv(config.providerSeeds) }
  if (seeded.agents || seeded.skills || seeded.prompts || seeded.providers.length) log.info('Seeded built-in data', seeded)
  const admin = auth.bootstrapAdmin(config.adminUsername, config.adminPassword, config.adminEmail)
  if (admin) log.info('Bootstrap administrator created', { username: admin.username })

  // Runs left active by a crashed process are marked failed.
  const orphaned = db.run("UPDATE agent_runs SET status = 'failed', error = 'Interrupted by server restart', finished_at = ? WHERE status IN ('queued','running','waiting_approval')", [now()]).changes
  db.run("UPDATE team_runs SET status = 'failed', error = 'Interrupted by server restart', finished_at = ? WHERE status IN ('planning','running','synthesizing')", [now()])
  db.run("UPDATE approvals SET status = 'expired' WHERE status = 'pending'")
  const recovered = tasks.recoverInterrupted()
  if (orphaned || recovered) log.warn('Recovered interrupted work from previous process', { runs: orphaned, tasks: recovered })

  services = {
    config, db, bus, log, metricsRegistry, metrics, secretBox, commandPolicy, auth, projectAccess, providers, router, registry, executor, approvals,
    agents, runner, conversations, orchestrator, messaging, memory, context, prompts, skills, plugins, mcp, projects, fs, git, editing, codegen,
    repo, planner, tasks, terminals, testing, debugging, review, deploy, settings, audit, symbolIndex, startedAt: now(),
  }

  return {
    ...services,
    async start() {
      await plugins.discover().catch((err) => log.warn('Plugin discovery failed', { error: err }))
      await plugins.activateEnabled()
      void mcp.connectEnabled()
      tasks.startScheduler(config.taskSchedulerIntervalMs)
    },
    async stop() {
      tasks.stopScheduler()
      for (const id of runner.activeRunIds) runner.cancel(id)
      terminals.shutdown()
      await mcp.shutdown()
      db.close()
    },
  }
}
