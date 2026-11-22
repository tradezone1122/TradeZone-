/**
 * Platform-wide event bus. Modules publish typed events on topics; the
 * WebSocket server forwards them to subscribed clients and the monitoring
 * system aggregates them.
 *
 * Topics:
 *   run:<runId>          agent run events (text deltas, tool calls, status)
 *   team:<teamRunId>     multi-agent orchestration events
 *   project:<projectId>  file changes, git changes, test runs
 *   terminal:<id>        terminal output
 *   approvals            approval requests
 *   system               logs, metrics, provider status
 */
export interface BusEvent<T = unknown> {
  topic: string
  type: string
  data: T
  time: string
}

export type BusListener = (event: BusEvent) => void

export class EventBus {
  private listeners = new Map<string, Set<BusListener>>()
  private wildcard = new Set<BusListener>()

  publish<T>(topic: string, type: string, data: T): void {
    const event: BusEvent<T> = { topic, type, data, time: new Date().toISOString() }
    const set = this.listeners.get(topic)
    if (set) for (const l of [...set]) safe(l, event)
    const prefix = topic.split(':')[0] + ':*'
    const pset = this.listeners.get(prefix)
    if (pset) for (const l of [...pset]) safe(l, event)
    for (const l of [...this.wildcard]) safe(l, event)
  }

  /** Subscribe to an exact topic, a prefix wildcard (`run:*`) or everything (`*`). */
  subscribe(topic: string, listener: BusListener): () => void {
    if (topic === '*') {
      this.wildcard.add(listener)
      return () => this.wildcard.delete(listener)
    }
    let set = this.listeners.get(topic)
    if (!set) {
      set = new Set()
      this.listeners.set(topic, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) this.listeners.delete(topic)
    }
  }

  /** Resolve with the first event on `topic` matching `predicate`. */
  waitFor(topic: string, predicate: (e: BusEvent) => boolean, timeoutMs: number): Promise<BusEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out waiting for event on ${topic}`))
      }, timeoutMs)
      const off = this.subscribe(topic, (e) => {
        if (predicate(e)) {
          clearTimeout(timer)
          off()
          resolve(e)
        }
      })
    })
  }

  listenerCount(): number {
    let n = this.wildcard.size
    for (const s of this.listeners.values()) n += s.size
    return n
  }
}

function safe(listener: BusListener, event: BusEvent): void {
  try {
    listener(event)
  } catch {
    // A faulty listener must not break publishers.
  }
}
