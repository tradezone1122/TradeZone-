/**
 * Robust JSON extraction from model output: handles fenced code blocks,
 * leading prose, trailing commentary and trailing commas.
 */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null
  const candidates: string[] = []
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) candidates.push(m[1]!)
  candidates.push(text)
  for (const c of candidates) {
    const direct = tryParse<T>(c.trim())
    if (direct !== null) return direct
    const balanced = findBalanced(c)
    if (balanced) {
      const parsed = tryParse<T>(balanced) ?? tryParse<T>(balanced.replace(/,\s*([}\]])/g, '$1'))
      if (parsed !== null) return parsed
    }
  }
  return null
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

function findBalanced(text: string): string | null {
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const open = text[start]!
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
