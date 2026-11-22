/**
 * Module 29 (part): Secret detection and redaction.
 *
 * Used by the logger (redaction), the code review engine (findings) and the
 * git integration (pre-commit secret scan).
 */

export interface SecretPattern {
  id: string
  description: string
  regex: RegExp
  severity: 'critical' | 'high' | 'medium'
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'anthropic-key', description: 'Anthropic API key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g, severity: 'critical' },
  { id: 'openai-key', description: 'OpenAI-style API key', regex: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, severity: 'critical' },
  { id: 'aws-access-key', description: 'AWS access key id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: 'critical' },
  { id: 'github-token', description: 'GitHub token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{50,}/g, severity: 'critical' },
  { id: 'slack-token', description: 'Slack token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, severity: 'high' },
  { id: 'google-api-key', description: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, severity: 'high' },
  { id: 'stripe-key', description: 'Stripe secret key', regex: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/g, severity: 'critical' },
  { id: 'private-key', description: 'PEM private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, severity: 'critical' },
  { id: 'platform-key', description: 'TradeZone API key', regex: /\btz_[A-Za-z0-9]{32,}\b/g, severity: 'critical' },
  { id: 'jwt', description: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, severity: 'medium' },
  {
    id: 'generic-assignment',
    description: 'Hard-coded credential assignment',
    regex: /\b(?:password|passwd|secret|api_key|apikey|access_token|auth_token)\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
    severity: 'high',
  },
]

export interface SecretFinding {
  patternId: string
  description: string
  severity: SecretPattern['severity']
  line: number
  column: number
  preview: string
}

export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  const lineStarts: number[] = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const locate = (index: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= index) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: index - lineStarts[lo]! + 1 }
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.regex.exec(text)) !== null) {
      const { line, column } = locate(match.index)
      const value = match[0]
      findings.push({
        patternId: pattern.id,
        description: pattern.description,
        severity: pattern.severity,
        line,
        column,
        preview: value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-2)}` : '***',
      })
      if (match[0].length === 0) pattern.regex.lastIndex++
    }
  }
  return findings
}

export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.id === 'generic-assignment') continue
    pattern.regex.lastIndex = 0
    out = out.replace(pattern.regex, (m) => `${m.slice(0, 4)}[REDACTED]`)
  }
  return out
}
