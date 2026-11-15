/**
 * Next.js standalone builds can bundle the same module into more than one
 * server chunk, giving each copy its own module-level `let`/`Map`. That breaks
 * anything that must be a true singleton: the poll mutex, cron `started`
 * guards, the recovery state machine, and alert cooldowns. (This already bit
 * the Unbound status cache once — see the 2026-06-10 fix.)
 *
 * `globalSingleton` anchors state on `globalThis`, which IS shared across all
 * chunks in the same Node process, so every import resolves to one instance.
 */
export function globalSingleton<T>(key: string, factory: () => T): T {
  const g = globalThis as unknown as Record<string, T | undefined>
  const existing = g[key]
  if (existing !== undefined) return existing
  const created = factory()
  g[key] = created
  return created
}

/**
 * Run `fn` exactly once per process, keyed by `key`, regardless of how many
 * module chunks call it. Returns true if this call performed the run.
 */
export function runOnce(key: string, fn: () => void): boolean {
  const flag = globalSingleton(key, () => ({ done: false }))
  if (flag.done) return false
  flag.done = true
  fn()
  return true
}

/**
 * True while `next build` is prerendering. The root layout starts the poller
 * at module load (a fallback for when instrumentation.js went missing from the
 * standalone output), and the build loads that layout to prerender pages — so
 * every build started polling whatever database it could see. In Docker that
 * DB is empty and it only logged "no such table"; with a real DB present (a
 * local build next to a copied DB) it would poll, and run SSH recovery
 * against, the live nodes. Never start background work during a build.
 */
export function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build'
}
