import fs from 'node:fs'
import path from 'node:path'

const NEST_DIR = '.nest'

/**
 * Locate the Nest root for a working directory.
 *
 * Resolution order, most explicit first:
 *   1. $NEST_ROOT              — set by a parent when it spawns a subordinate
 *   2. nearest ancestor with .nest/   — an already-initialised Nest
 *   3. nearest ancestor with .git/    — the repository root, for `nest init`
 *   4. the starting directory
 *
 * Step 3 matters: before `nest init` runs there is no .nest/ to find, and we
 * want init to land at the repository root rather than wherever the member
 * happened to be standing.
 */
export function findNestRoot (startDir = process.cwd()) {
  if (process.env.NEST_ROOT) return path.resolve(process.env.NEST_ROOT)

  const existing = walkUp(startDir, dir => fs.existsSync(path.join(dir, NEST_DIR)))
  if (existing) return existing

  const repo = walkUp(startDir, dir => fs.existsSync(path.join(dir, '.git')))
  if (repo) return repo

  return path.resolve(startDir)
}

function walkUp (startDir, predicate) {
  let dir = path.resolve(startDir)
  for (;;) {
    if (predicate(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function nestPaths (root = findNestRoot()) {
  const nest = path.join(root, NEST_DIR)
  return {
    root,
    nest,
    charter: path.join(nest, 'charter.json'),
    org: path.join(nest, 'org.json'),
    events: path.join(nest, 'log', 'events.jsonl'),
    inboxDir: path.join(nest, 'inbox'),
    reportsDir: path.join(nest, 'reports'),
    claimsDir: path.join(nest, 'claims'),
    briefsDir: path.join(nest, 'briefs'),
    assignmentsDir: path.join(nest, 'assignments'),
    inbox: id => path.join(nest, 'inbox', `${id}.jsonl`),
    reports: id => path.join(nest, 'reports', id),
    brief: id => path.join(nest, 'briefs', `${id}.md`),
    assignment: id => path.join(nest, 'assignments', `${id}.md`)
  }
}

export function ensureNestDirs (p = nestPaths()) {
  for (const dir of [p.nest, path.dirname(p.events), p.inboxDir, p.reportsDir, p.claimsDir, p.briefsDir, p.assignmentsDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return p
}

export function nestExists (p = nestPaths()) {
  return fs.existsSync(p.nest)
}
