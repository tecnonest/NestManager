/**
 * Area claims — the mechanism behind "peers coordinate, the Manager rules".
 *
 * The Nest does not try to prevent conflicting edits by force. It makes them
 * *visible before they happen*, names the other party, and gives the two peers
 * a channel to settle it themselves. Only when that fails does a Manager impose
 * an ordering. Overlap detection therefore has one job: never miss a real
 * collision, and be cheap enough to run before every edit.
 */

/**
 * Do two path patterns contend for the same ground?
 *
 * Deliberately conservative: it compares the literal prefix each pattern is
 * anchored to, so `src/**` and `src/nest/events.mjs` collide. Over-reporting
 * costs one negotiation message; under-reporting costs a lost edit, so the
 * asymmetry is intentional.
 */
export function patternsOverlap (a, b) {
  const [x, y] = [normalise(a), normalise(b)]
  if (x === y) return true

  const [px, py] = [literalPrefix(x), literalPrefix(y)]
  return px.startsWith(py) || py.startsWith(px)
}

/**
 * Claims held by members that have finished or been stopped are not conflicts.
 *
 * Nobody is behind them any more, so treating them as live locks the ground
 * they covered forever: a later member negotiates with a peer that will never
 * answer, escalates, and the supervisor has to rule on a dispute with one
 * participant. `activeOwners` is optional so the pure overlap logic stays
 * testable on its own, but callers that have the org chart should always pass
 * it.
 */
export function findConflicts (pattern, claims, requesterId, activeOwners = null) {
  return claims.filter(claim =>
    claim.state !== 'released' &&
    claim.owner !== requesterId &&
    claim.pattern &&
    (activeOwners === null || activeOwners.has(claim.owner)) &&
    patternsOverlap(pattern, claim.pattern)
  )
}

export function normalise (pattern) {
  return String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Everything up to the first wildcard — the directory a pattern is rooted in. */
export function literalPrefix (pattern) {
  const wildcard = pattern.search(/[*?[]/)
  const literal = wildcard === -1 ? pattern : pattern.slice(0, wildcard)
  return literal.includes('/') ? literal.slice(0, literal.lastIndexOf('/') + 1) : ''
}

export function claimId (pattern, ownerId) {
  return `${normalise(pattern).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}--${ownerId.slice(0, 8)}`
}

/**
 * Has a peer negotiation run out of road?
 *
 * Both bounds matter for different failure modes: the exchange count catches
 * two peers talking past each other, the silence window catches a peer that
 * died mid-negotiation and will never reply.
 */
export function negotiationExhausted (exchanges, lastReplyAt, now = Date.now(), limits = {}) {
  const { max_exchanges = 3, silence_minutes = 2 } = limits

  if (exchanges >= max_exchanges) {
    return { exhausted: true, why: `${exchanges} exchanges without agreement` }
  }
  if (lastReplyAt && (now - Date.parse(lastReplyAt)) / 60000 >= silence_minutes) {
    return { exhausted: true, why: `peer silent for ${silence_minutes}m` }
  }
  return { exhausted: false }
}
