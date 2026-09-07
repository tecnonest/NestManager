/**
 * Model routing.
 *
 * The capability ladder lives in the Charter rather than in this file. Model
 * line-ups change, and a hardcoded ranking would quietly become wrong; putting
 * the order in configuration means a stale ranking is a one-line fix instead of
 * a release.
 *
 * Routing is deliberately a pure function of declared task signals. That makes
 * it auditable — every dispatch records why a tier was chosen — and testable
 * without launching a single session.
 */

/** Signals a Manager declares about a task before dispatching it. */
export const SIGNAL_SCHEMA = Object.freeze({
  mechanical: 'boolean — deterministic, no judgement required',
  specified: 'boolean — the desired outcome is fully written down',
  scope: "'single-file' | 'module' | 'cross-cutting'",
  ambiguity: "'none' | 'some' | 'high'",
  risk: "'low' | 'medium' | 'high' | 'irreversible'",
  unknown_root_cause: 'boolean — debugging without a diagnosis',
  prior_failures: 'integer — how many times this task already failed'
})

const ADJUSTMENTS = [
  { when: s => s.ambiguity === 'high', delta: +1, why: 'requirements are ambiguous' },
  { when: s => s.unknown_root_cause, delta: +1, why: 'root cause is unknown' },
  { when: s => s.scope === 'cross-cutting', delta: +1, why: 'change cuts across modules' },
  { when: s => s.risk === 'irreversible', delta: +1, why: 'decision is irreversible' },
  { when: s => s.risk === 'high', delta: +1, why: 'high blast radius' },
  { when: s => s.mechanical && s.specified && s.scope === 'single-file', delta: -1, why: 'mechanical and fully specified' },
  { when: s => s.ambiguity === 'none' && s.specified && !s.unknown_root_cause, delta: -1, why: 'unambiguous and pre-specified' }
]

export function routeTask (signals = {}, charter) {
  const s = normaliseSignals(signals)
  const { ladder, floor, ceiling, default: fallback, roster } = charter.models

  let index = ladder.indexOf(fallback)
  const rationale = []

  for (const rule of ADJUSTMENTS) {
    if (!rule.when(s)) continue
    index += rule.delta
    rationale.push(`${rule.delta > 0 ? '+' : ''}${rule.delta} ${rule.why}`)
  }

  if (s.prior_failures > 0) {
    index += s.prior_failures
    rationale.push(`+${s.prior_failures} escalation after ${s.prior_failures} failed attempt(s)`)
  }

  const clamped = clamp(index, ladder.indexOf(floor), ladder.indexOf(ceiling))
  if (clamped !== index) {
    rationale.push(`clamped to charter bounds [${floor}..${ceiling}]`)
  }

  const model = nearestAvailable(ladder, clamped, roster, ladder.indexOf(floor), ladder.indexOf(ceiling))
  if (model !== ladder[clamped]) {
    rationale.push(`${ladder[clamped]} is not on the roster, using ${model}`)
  }

  return { model, rationale, signals: s }
}

/**
 * A tier can be permitted by the ceiling yet absent from the roster, because the
 * user may not have access to it. Something has to give, and the two ways of
 * being wrong are not equally bad:
 *
 *   over-provisioning  — wastes money, and `correctRouting` claws it back once
 *                        a task completes with trivial effort
 *   under-provisioning — produces wrong work, which costs the money anyway on
 *                        the retry, plus whatever the bad output broke
 *
 * So we search upward first and only fall back down when nothing capable
 * remains. Systematic over-provisioning is then corrected from observed
 * outcomes rather than guessed at up front.
 */
function nearestAvailable (ladder, index, roster, floorIndex, ceilingIndex) {
  if (roster.includes(ladder[index])) return ladder[index]

  for (let i = index + 1; i <= ceilingIndex; i++) {
    if (roster.includes(ladder[i])) return ladder[i]
  }
  for (let i = index - 1; i >= floorIndex; i--) {
    if (roster.includes(ladder[i])) return ladder[i]
  }
  return ladder[clamp(index, floorIndex, ceilingIndex)]
}

/**
 * Decide what to do after a subordinate reports.
 *
 * Escalation is the safety valve for under-provisioning; de-escalation is how
 * the Nest stops burning a premium model on work that did not need it. Both are
 * recorded as `routing_correction` events so the reasoning stays auditable.
 */
export function correctRouting (report, previousModel, charter) {
  const { ladder, floor, ceiling } = charter.models
  const index = ladder.indexOf(previousModel)

  if (report.status === 'blocked' && report.reason === 'beyond_capability') {
    return correction(index, +1, 'subordinate reported the task exceeded its capability', ladder, floor, ceiling)
  }
  if (report.status === 'failed' && (report.attempt ?? 1) >= 2) {
    return correction(index, +1, `failed ${report.attempt} times at ${previousModel}`, ladder, floor, ceiling)
  }
  if (report.status === 'done' && report.effort === 'trivial') {
    return correction(index, -1, 'completed with trivial effort — over-provisioned', ladder, floor, ceiling)
  }
  return null
}

function correction (index, delta, why, ladder, floor, ceiling) {
  const target = clamp(index + delta, ladder.indexOf(floor), ladder.indexOf(ceiling))
  if (target === index) return null
  return { from: ladder[index], to: ladder[target], direction: delta > 0 ? 'escalate' : 'de-escalate', why }
}

function normaliseSignals (signals) {
  return {
    mechanical: Boolean(signals.mechanical),
    specified: Boolean(signals.specified),
    scope: signals.scope ?? 'module',
    ambiguity: signals.ambiguity ?? 'some',
    risk: signals.risk ?? 'medium',
    unknown_root_cause: Boolean(signals.unknown_root_cause),
    prior_failures: Number(signals.prior_failures ?? 0)
  }
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
