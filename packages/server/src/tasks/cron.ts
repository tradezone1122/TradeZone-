/**
 * Minimal 5-field cron parser (minute hour day-of-month month day-of-week)
 * supporting `*`, lists, ranges, steps and the @hourly/@daily/@weekly/@monthly
 * shorthands. Used by the task scheduler for recurring tasks.
 */
const SHORTCUTS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
}

const RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
]

export interface CronSpec {
  fields: Array<Set<number>>
  domRestricted: boolean
  dowRestricted: boolean
}

export function parseCron(expr: string): CronSpec {
  const src = SHORTCUTS[expr.trim()] ?? expr.trim()
  const parts = src.split(/\s+/)
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields: "${expr}"`)
  const fields = parts.map((p, i) => parseField(p, RANGES[i]![0], RANGES[i]![1], i))
  return { fields, domRestricted: parts[2] !== '*', dowRestricted: parts[4] !== '*' }
}

function parseField(field: string, min: number, max: number, index: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in "${field}"`)
    let lo = min
    let hi = max
    if (rangePart && rangePart !== '*') {
      const [a, b] = rangePart.split('-')
      lo = Number(a)
      hi = b !== undefined ? Number(b) : stepPart ? max : lo
    }
    if (index === 4) {
      if (lo === 7) lo = 0
      if (hi === 7) hi = 6
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`Invalid range "${part}" (allowed ${min}-${max})`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

function matches(spec: CronSpec, d: Date): boolean {
  const [mins, hours, dom, months, dow] = spec.fields as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (!mins.has(d.getUTCMinutes()) || !hours.has(d.getUTCHours()) || !months.has(d.getUTCMonth() + 1)) return false
  const domOk = dom.has(d.getUTCDate())
  const dowOk = dow.has(d.getUTCDay())
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

/** Next matching time strictly after `from` (UTC). */
export function nextCronTime(expr: string, from: Date = new Date()): Date {
  const spec = parseCron(expr)
  const d = new Date(from.getTime())
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(d.getUTCMinutes() + 1)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(spec, d)) return d
    d.setUTCMinutes(d.getUTCMinutes() + 1)
  }
  throw new Error(`Cron expression "${expr}" never matches`)
}
