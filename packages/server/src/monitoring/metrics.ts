/**
 * Module 38: Monitoring System — metrics registry.
 *
 * Counters, gauges and histograms with label support, exported in the
 * Prometheus text exposition format at `/metrics` and as JSON for the admin
 * dashboard.
 */

type Labels = Record<string, string>

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',')
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  abstract render(): string
  abstract toJSON(): unknown
}

export class Counter extends Metric {
  private values = new Map<string, { labels: Labels; value: number }>()
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels)
    const e = this.values.get(k)
    if (e) e.value += by
    else this.values.set(k, { labels, value: by })
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels))?.value ?? 0
  }
  total(): number {
    let t = 0
    for (const v of this.values.values()) t += v.value
    return t
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${Object.keys(labels).length ? `{${key(labels)}}` : ''} ${value}`)
    return lines.join('\n')
  }
  toJSON() {
    return [...this.values.values()]
  }
}

export class Gauge extends Metric {
  private values = new Map<string, { labels: Labels; value: number }>()
  private collector?: () => number
  set(value: number, labels: Labels = {}): void {
    this.values.set(key(labels), { labels, value })
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels)
    const e = this.values.get(k)
    if (e) e.value += by
    else this.values.set(k, { labels, value: by })
  }
  dec(labels: Labels = {}, by = 1): void {
    this.inc(labels, -by)
  }
  collect(fn: () => number): this {
    this.collector = fn
    return this
  }
  get(labels: Labels = {}): number {
    if (this.collector && !Object.keys(labels).length) return this.collector()
    return this.values.get(key(labels))?.value ?? 0
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    if (this.collector) lines.push(`${this.name} ${this.collector()}`)
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${Object.keys(labels).length ? `{${key(labels)}}` : ''} ${value}`)
    return lines.join('\n')
  }
  toJSON() {
    return this.collector ? [{ labels: {}, value: this.collector() }] : [...this.values.values()]
  }
}

export class Histogram extends Metric {
  private series = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>()
  constructor(
    name: string,
    help: string,
    readonly bounds: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  ) {
    super(name, help)
  }
  observe(value: number, labels: Labels = {}): void {
    const k = key(labels)
    let s = this.series.get(k)
    if (!s) {
      s = { labels, buckets: new Array(this.bounds.length).fill(0), sum: 0, count: 0 }
      this.series.set(k, s)
    }
    s.sum += value
    s.count++
    for (let i = 0; i < this.bounds.length; i++) if (value <= this.bounds[i]!) s.buckets[i]!++
  }
  quantile(q: number, labels: Labels = {}): number {
    const s = this.series.get(key(labels))
    if (!s || !s.count) return 0
    const target = q * s.count
    for (let i = 0; i < this.bounds.length; i++) if (s.buckets[i]! >= target) return this.bounds[i]!
    return this.bounds[this.bounds.length - 1]!
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const s of this.series.values()) {
      const base = key(s.labels)
      this.bounds.forEach((b, i) => lines.push(`${this.name}_bucket{${base ? base + ',' : ''}le="${b}"} ${s.buckets[i]}`))
      lines.push(`${this.name}_bucket{${base ? base + ',' : ''}le="+Inf"} ${s.count}`)
      lines.push(`${this.name}_sum${base ? `{${base}}` : ''} ${s.sum}`)
      lines.push(`${this.name}_count${base ? `{${base}}` : ''} ${s.count}`)
    }
    return lines.join('\n')
  }
  toJSON() {
    return [...this.series.values()].map((s) => ({ labels: s.labels, count: s.count, sum: s.sum, avg: s.count ? s.sum / s.count : 0 }))
  }
}

export class MetricsRegistry {
  private metrics = new Map<string, Metric>()

  counter(name: string, help: string): Counter {
    return this.register(name, () => new Counter(name, help)) as Counter
  }
  gauge(name: string, help: string): Gauge {
    return this.register(name, () => new Gauge(name, help)) as Gauge
  }
  histogram(name: string, help: string, bounds?: number[]): Histogram {
    return this.register(name, () => new Histogram(name, help, bounds)) as Histogram
  }
  private register(name: string, make: () => Metric): Metric {
    let m = this.metrics.get(name)
    if (!m) {
      m = make()
      this.metrics.set(name, m)
    }
    return m
  }
  renderPrometheus(): string {
    return [...this.metrics.values()].map((m) => m.render()).join('\n\n') + '\n'
  }
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [n, m] of this.metrics) out[n] = m.toJSON()
    return out
  }
}

/** Standard platform metrics. */
export function createPlatformMetrics(registry: MetricsRegistry) {
  return {
    httpRequests: registry.counter('tz_http_requests_total', 'HTTP requests by method, route and status'),
    httpDuration: registry.histogram('tz_http_request_duration_ms', 'HTTP request duration in milliseconds'),
    llmRequests: registry.counter('tz_llm_requests_total', 'LLM requests by provider, model and outcome'),
    llmTokens: registry.counter('tz_llm_tokens_total', 'LLM tokens by provider, model and direction'),
    llmLatency: registry.histogram('tz_llm_latency_ms', 'LLM request latency in milliseconds'),
    toolCalls: registry.counter('tz_tool_calls_total', 'Tool calls by tool and outcome'),
    toolDuration: registry.histogram('tz_tool_duration_ms', 'Tool execution duration in milliseconds'),
    runsActive: registry.gauge('tz_agent_runs_active', 'Agent runs currently executing'),
    runsTotal: registry.counter('tz_agent_runs_total', 'Agent runs by final status'),
    wsConnections: registry.gauge('tz_ws_connections', 'Open WebSocket connections'),
    terminalSessions: registry.gauge('tz_terminal_sessions', 'Open terminal sessions'),
    tasksTotal: registry.counter('tz_tasks_total', 'Tasks processed by final status'),
  }
}

export type PlatformMetrics = ReturnType<typeof createPlatformMetrics>
