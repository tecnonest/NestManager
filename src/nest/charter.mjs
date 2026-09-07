import fs from 'node:fs'
import { nestPaths, ensureNestDirs } from './paths.mjs'

/**
 * The Charter is the engagement contract between the human and the Executive.
 *
 * It is negotiated once, at intake, and then governs every autonomous decision
 * the hierarchy makes. Everything a subordinate is allowed to do without asking
 * a human is derived from this file.
 */

export const DEFAULT_CHARTER = Object.freeze({
  objective: null,
  limits: { max_members: 8, max_depth: 3, max_concurrent: 4 },
  // `total_usd` is the enforceable cap: it is the only unit the harness can
  // apply (`--max-budget-usd`) and the only one comparable across model tiers,
  // where the same token count can differ in cost by an order of magnitude.
  // `total_tokens` is advisory — recorded and reported, never used to refuse a
  // hire — because a token ceiling cannot bound a hierarchy that mixes tiers.
  budget: { total_usd: null, total_tokens: null, reserve_pct: 20 },
  models: { ladder: ['haiku', 'sonnet', 'opus', 'fable'], roster: ['haiku', 'sonnet', 'opus'], ceiling: 'opus', floor: 'haiku', default: 'sonnet' },
  escalation: {
    always_ask: ['destructive_ops', 'external_comms', 'budget_overrun', 'scope_change'],
    never_ask: ['model_choice', 'task_split', 'hiring_within_limits']
  },
  sla: { heartbeat_minutes: 5, quiet_minutes: 10, stall_minutes: 20, lost_minutes: 45, max_nudges: 2 },
  unattended: { enabled: false, interval_minutes: 15 },
  isolation: 'auto',
  // Only needed when NestManager is run from a clone via `--plugin-dir`, which
  // applies to one session and not to the sessions it spawns. Without this a
  // subordinate would start with no hooks and no role skills, and would ignore
  // a protocol it was never given. Installed plugins need no setting.
  plugin_dir: null
})

export function loadCharter (paths = nestPaths()) {
  if (!fs.existsSync(paths.charter)) return null
  return mergeCharter(JSON.parse(fs.readFileSync(paths.charter, 'utf8')))
}

export function saveCharter (charter, paths = nestPaths()) {
  ensureNestDirs(paths)
  const merged = mergeCharter(charter)
  const problems = validateCharter(merged)
  if (problems.length) throw new Error(`invalid charter:\n  - ${problems.join('\n  - ')}`)
  fs.writeFileSync(paths.charter, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

/** Shallow-merge each top-level section over its defaults, so a partial charter is legal. */
export function mergeCharter (charter = {}) {
  const merged = { ...DEFAULT_CHARTER }
  for (const [key, value] of Object.entries(charter)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...DEFAULT_CHARTER[key], ...value }
      : value
  }
  return merged
}

export function validateCharter (charter) {
  const problems = []
  const { limits, budget, models, sla } = charter

  if (!(limits.max_members >= 1)) problems.push('limits.max_members must be at least 1')
  if (!(limits.max_depth >= 1)) problems.push('limits.max_depth must be at least 1')
  if (!(limits.max_concurrent >= 1)) problems.push('limits.max_concurrent must be at least 1')

  if (budget.total_usd !== null && !(budget.total_usd > 0)) {
    problems.push('budget.total_usd must be a positive number or null for uncapped')
  }
  if (budget.total_tokens !== null && !(budget.total_tokens > 0)) {
    problems.push('budget.total_tokens must be a positive number or null for untracked')
  }
  if (!(budget.reserve_pct >= 0 && budget.reserve_pct < 100)) {
    problems.push('budget.reserve_pct must be between 0 and 99')
  }

  for (const name of ['ceiling', 'floor', 'default']) {
    if (!models.ladder.includes(models[name])) {
      problems.push(`models.${name} (${models[name]}) is not on models.ladder`)
    }
  }
  if (models.ladder.indexOf(models.floor) > models.ladder.indexOf(models.ceiling)) {
    problems.push('models.floor ranks above models.ceiling')
  }
  for (const model of models.roster) {
    if (!models.ladder.includes(model)) problems.push(`models.roster contains unknown model "${model}"`)
  }

  if (!(sla.quiet_minutes < sla.stall_minutes && sla.stall_minutes < sla.lost_minutes)) {
    problems.push('sla thresholds must increase: quiet < stall < lost')
  }

  return problems
}

/**
 * How much a member may still grant to a new subordinate.
 *
 * Each parent withholds `reserve_pct` of its own grant so that it can afford to
 * re-run a failed task one model tier higher (see routing.mjs). Without the
 * reserve, a parent that allocated everything would be unable to recover from a
 * subordinate's failure without going back to the human.
 */
export function allocatableBudget (member, children, charter) {
  if (charter.budget.total_usd === null) return null // uncapped

  const reserve = member.budget_usd * (charter.budget.reserve_pct / 100)

  // A finished or stopped subordinate only ties up what it actually spent; the
  // rest of its grant returns to the parent. Holding the full grant forever
  // would slowly starve a long engagement until the supervisor could not hire
  // at all while real money sat unused.
  const committed = children.reduce(
    (sum, child) => sum + (TERMINATED.has(child.status) ? child.spent_usd : child.budget_usd),
    0
  )

  return Math.max(0, round(member.budget_usd - committed - member.spent_usd - reserve))
}

const TERMINATED = new Set(['done', 'failed', 'stopped', 'cancelled'])

export function canHire (org, charter, parentId) {
  const active = org.members.filter(m => ['working', 'stalled'].includes(m.status))
  const reasons = []

  if (org.members.length >= charter.limits.max_members) {
    reasons.push(`headcount cap reached (${charter.limits.max_members})`)
  }
  if (active.length >= charter.limits.max_concurrent) {
    reasons.push(`concurrency cap reached (${charter.limits.max_concurrent})`)
  }
  if (depthOf(org, parentId) + 1 >= charter.limits.max_depth) {
    reasons.push(`depth cap reached (${charter.limits.max_depth})`)
  }

  return { allowed: reasons.length === 0, reasons }
}

export function depthOf (org, memberId) {
  const byId = new Map(org.members.map(m => [m.id, m]))
  let depth = 0
  let current = byId.get(memberId)
  const seen = new Set()
  while (current?.parent && !seen.has(current.id)) {
    seen.add(current.id)
    current = byId.get(current.parent)
    depth += 1
  }
  return depth
}

const round = n => Math.round(n * 1e6) / 1e6
