#!/usr/bin/env node
/**
 * `tradezone` command-line interface.
 *
 *   tradezone serve                       start the server (same as npm start)
 *   tradezone migrate                     apply database migrations
 *   tradezone create-admin <user> <pass>  create an administrator
 *   tradezone run <agent> "<task>" [--project <id|slug>] [--model <ref>]
 *                                         run an agent from the terminal, streaming output
 *   tradezone mcp [--project <id|slug>]   serve platform tools as an MCP server on stdio
 *   tradezone routes                      list the REST API routes
 */
import path from 'node:path'
import { loadConfig, loadDotEnv } from './config/index.js'
import { createPlatform } from './platform.js'
import { buildServer } from './api/server.js'
import { serveStdio } from './mcp/mcp-server.js'
import { logHub } from './logging/logger.js'

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<void> {
  loadDotEnv(path.resolve(process.cwd(), '.env'))
  const [cmd = 'help', ...args] = process.argv.slice(2)
  if (cmd === 'serve') {
    await import('./index.js').then(() => undefined)
    const { spawn } = await import('node:child_process')
    spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('./index.js', import.meta.url).pathname], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0))
    return
  }
  if (cmd === 'mcp') logHub.stdout = false // stdout carries the MCP protocol
  const config = loadConfig()
  const platform = createPlatform(config)
  try {
    switch (cmd) {
      case 'migrate':
        console.log('Database is up to date.')
        break
      case 'create-admin': {
        const [username, password] = args
        if (!username || !password) throw new Error('Usage: tradezone create-admin <username> <password>')
        const u = platform.auth.createUser({ username, password, role: 'admin' })
        console.log(`Created administrator ${u.username} (${u.id})`)
        break
      }
      case 'run': {
        const [agentName, ...rest] = args.filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))
        const task = rest.join(' ')
        if (!agentName || !task) throw new Error('Usage: tradezone run <agent> "<task>" [--project <id>] [--model <ref>]')
        const agent = platform.agents.get(agentName)
        const projectId = flag(args, 'project')
        const p = projectId ? platform.projects.get(projectId) : undefined
        logHub.stdout = false
        const { runId, done } = platform.runner.start({ agent, input: task, model: flag(args, 'model'), project: p ? { id: p.id, name: p.name, rootPath: p.rootPath, instructions: p.settings.instructions } : undefined })
        platform.bus.subscribe(`run:${runId}`, (e) => {
          const d = e.data as Record<string, unknown>
          if (e.type === 'text.delta') process.stdout.write(String(d.text))
          else if (e.type === 'tool.call') process.stdout.write(`\n\x1b[36m→ ${d.name} ${JSON.stringify(d.input).slice(0, 200)}\x1b[0m\n`)
          else if (e.type === 'tool.result') process.stdout.write(`\x1b[${d.isError ? 31 : 32}m← ${String(d.content).split('\n')[0]!.slice(0, 200)}\x1b[0m\n`)
        })
        const outcome = await done
        console.log(`\n\n[${outcome.run.status}] turns=${outcome.run.turns} tokens=${outcome.run.tokensIn}/${outcome.run.tokensOut} tools=${outcome.run.toolCalls}${outcome.run.error ? ` error=${outcome.run.error}` : ''}`)
        process.exitCode = outcome.run.status === 'completed' ? 0 : 1
        break
      }
      case 'mcp': {
        const projectId = flag(args, 'project')
        const p = projectId ? platform.projects.get(projectId) : undefined
        await serveStdio({ registry: platform.registry, executor: platform.executor, services: platform, project: p ? { id: p.id, rootPath: p.rootPath } : undefined })
        return // keep running
      }
      case 'routes': {
        const { api } = await buildServer(platform)
        for (const r of api.routes) console.log(`${r.method.padEnd(6)} ${r.url}  [${r.perm}]`)
        console.log(`\n${api.count} routes`)
        break
      }
      default:
        console.log('Usage: tradezone <serve|migrate|create-admin|run|mcp|routes>')
    }
  } finally {
    if (cmd !== 'mcp') await platform.stop()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
