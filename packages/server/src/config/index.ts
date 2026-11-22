/**
 * Module: Configuration
 *
 * Loads platform configuration from environment variables (and an optional
 * `.env` file) and validates it with zod. Every other module receives the
 * resolved `AppConfig` object instead of reading `process.env` directly, which
 * keeps tests hermetic.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

const ConfigSchema = z.object({
  env: z.enum(['development', 'production', 'test']).default('development'),
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(0).max(65535).default(8787),
  /** Root directory for persistent data (database, skills, plugins, workspaces). */
  dataDir: z.string(),
  /** Directory where new projects are created / cloned. */
  workspacesDir: z.string(),
  /** Path to the SQLite database file (or ":memory:"). */
  databasePath: z.string(),
  /** Secret used to sign JWTs and derive the encryption key for stored API keys. */
  secretKey: z.string().min(16),
  jwtTtlSeconds: z.coerce.number().int().positive().default(60 * 60 * 12),
  corsOrigins: z.array(z.string()).default([]),
  /** Directory containing the built frontend, served statically if present. */
  webDistDir: z.string().optional(),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** Initial admin bootstrap credentials (optional; otherwise use /api/auth/setup). */
  adminUsername: z.string().optional(),
  adminPassword: z.string().optional(),
  adminEmail: z.string().optional(),
  /** Command execution safety. */
  commandTimeoutMs: z.coerce.number().int().positive().default(120_000),
  maxConcurrentRuns: z.coerce.number().int().positive().default(4),
  maxTerminalSessions: z.coerce.number().int().positive().default(16),
  allowUnsafeCommands: boolish.default(false),
  rateLimitPerMinute: z.coerce.number().int().positive().default(600),
  /** Provider credentials picked up on first boot and seeded into the provider table. */
  providerSeeds: z.object({
    anthropicApiKey: z.string().optional(),
    anthropicBaseUrl: z.string().optional(),
    openaiApiKey: z.string().optional(),
    openaiBaseUrl: z.string().optional(),
    moonshotApiKey: z.string().optional(),
    deepseekApiKey: z.string().optional(),
    openrouterApiKey: z.string().optional(),
    geminiApiKey: z.string().optional(),
    ollamaBaseUrl: z.string().optional(),
  }),
  defaultModel: z.string().optional(),
  taskSchedulerIntervalMs: z.coerce.number().int().positive().default(2000),
})

export type AppConfig = z.infer<typeof ConfigSchema>

/** Parse a dotenv file (KEY=VALUE, # comments, optional quotes). Existing env wins. */
export function loadDotEnv(file: string, target: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (target[key] === undefined) target[key] = value
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = path.resolve(overrides.dataDir ?? env.TZ_DATA_DIR ?? path.join(process.cwd(), 'data'))
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['env']
  let secretKey = overrides.secretKey ?? env.TZ_SECRET_KEY
  if (!secretKey) {
    if (nodeEnv === 'production') {
      throw new Error('TZ_SECRET_KEY must be set in production (at least 16 characters).')
    }
    // Development fallback: random per-process secret (tokens are invalidated on restart).
    secretKey = randomBytes(32).toString('hex')
  }
  const raw = {
    env: nodeEnv,
    host: env.TZ_HOST,
    port: env.TZ_PORT ?? env.PORT,
    dataDir,
    workspacesDir: path.resolve(env.TZ_WORKSPACES_DIR ?? path.join(dataDir, 'workspaces')),
    databasePath: env.TZ_DATABASE_PATH ?? path.join(dataDir, 'tradezone.db'),
    secretKey,
    jwtTtlSeconds: env.TZ_JWT_TTL_SECONDS,
    corsOrigins: env.TZ_CORS_ORIGINS ? env.TZ_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    webDistDir: env.TZ_WEB_DIST_DIR,
    logLevel: env.TZ_LOG_LEVEL,
    adminUsername: env.TZ_ADMIN_USERNAME,
    adminPassword: env.TZ_ADMIN_PASSWORD,
    adminEmail: env.TZ_ADMIN_EMAIL,
    commandTimeoutMs: env.TZ_COMMAND_TIMEOUT_MS,
    maxConcurrentRuns: env.TZ_MAX_CONCURRENT_RUNS,
    maxTerminalSessions: env.TZ_MAX_TERMINAL_SESSIONS,
    allowUnsafeCommands: env.TZ_ALLOW_UNSAFE_COMMANDS,
    rateLimitPerMinute: env.TZ_RATE_LIMIT_PER_MINUTE,
    providerSeeds: {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
      openaiApiKey: env.OPENAI_API_KEY,
      openaiBaseUrl: env.OPENAI_BASE_URL,
      moonshotApiKey: env.MOONSHOT_API_KEY,
      deepseekApiKey: env.DEEPSEEK_API_KEY,
      openrouterApiKey: env.OPENROUTER_API_KEY,
      geminiApiKey: env.GEMINI_API_KEY,
      ollamaBaseUrl: env.OLLAMA_BASE_URL,
    },
    defaultModel: env.TZ_DEFAULT_MODEL,
    taskSchedulerIntervalMs: env.TZ_TASK_SCHEDULER_INTERVAL_MS,
  }
  const cleaned = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
  return ConfigSchema.parse({ ...cleaned, ...overrides })
}
