/**
 * Server entry point: load configuration, build the platform and API server,
 * listen, and shut down gracefully on SIGINT/SIGTERM.
 */
import path from 'node:path'
import { loadConfig, loadDotEnv } from './config/index.js'
import { createPlatform } from './platform.js'
import { buildServer } from './api/server.js'

export { createPlatform } from './platform.js'
export { buildServer } from './api/server.js'
export { loadConfig } from './config/index.js'

async function main(): Promise<void> {
  loadDotEnv(path.resolve(process.cwd(), '.env'))
  const config = loadConfig()
  const platform = createPlatform(config)
  const { app, api } = await buildServer(platform)
  await platform.start()
  await app.listen({ host: config.host, port: config.port })
  platform.log.info('TradeZone AI Platform listening', { url: `http://${config.host}:${config.port}`, routes: api.count, tools: platform.registry.list().length, needsSetup: platform.auth.needsSetup() })
  if (platform.auth.needsSetup()) platform.log.warn('No users exist yet: open the web UI to create the administrator account (or set TZ_ADMIN_USERNAME/TZ_ADMIN_PASSWORD).')

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    platform.log.info('Shutting down', { signal })
    const force = setTimeout(() => process.exit(1), 15_000)
    force.unref()
    try {
      await app.close()
      await platform.stop()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => platform.log.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason : String(reason) }))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\.(ts|js)$/, '') === path.resolve(new URL(import.meta.url).pathname).replace(/\.(ts|js)$/, '')
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
