import { globalSingleton } from '@/lib/global-state'

/**
 * Load controls for viewer-reachable Pi-hole calls (FIX-PLAN P5.1, R2-NV2).
 *
 * Any session, viewer included, can ask for a 30-day history or a 1000-row
 * query-log scan. Those run against FTL's on-disk database and are slow: the
 * 30-day /api/history/database took ~60 s on .16 and ~17 s on .8 (2026-11).
 * Before this, every request started its own node call, a client disconnect
 * never cancelled it, and nothing bounded how many ran at once.
 *
 * Two tools, both anchored on globalThis (see global-state.ts):
 *
 * - A per-node "heavy lane": at most ONE heavy call in flight per node. Heavy
 *   means /history/database and /queries only. Summary, blocking, top lists,
 *   /history (24 h) and /info stay outside it: they are answered from FTL's
 *   in-memory data, and the poller (worker.ts, version-check.ts) uses them, so
 *   queueing them behind a 60 s history call would make the health check time
 *   out and start SSH recovery on a healthy node.
 * - In-flight coalescing: concurrent requests for the same key share one node
 *   call. A shared call is aborted only when every waiter has left, unless it
 *   is `detached` (filling a cache), in which case only its own timeout ends it.
 */

/** A waiter queue that would grow past this is refused instead of queued. */
const MAX_QUEUED_PER_NODE = 20

export class NodeBusyError extends Error {
  constructor() {
    super('Pi-hole node is busy with other long-running requests; try again shortly')
    this.name = 'NodeBusyError'
  }
}

type Waiter = { grant: () => void }
type Lane = { busy: boolean; queue: Waiter[] }

const lanes = globalSingleton('__piholeHeavyLanes', () => new Map<string, Lane>())

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/**
 * Take the node's heavy slot, waiting in FIFO order. A waiter whose signal
 * aborts leaves the queue and never starts a node call. Resolves to the
 * release function, which must be called exactly once.
 */
function acquire(node: string, signal: AbortSignal): Promise<() => void> {
  let lane = lanes.get(node)
  if (!lane) {
    lane = { busy: false, queue: [] }
    lanes.set(node, lane)
  }
  const l = lane
  let released = false
  const release = () => {
    if (released) return
    released = true
    const next = l.queue.shift()
    if (next) next.grant()
    else {
      l.busy = false
      lanes.delete(node)
    }
  }
  if (signal.aborted) return Promise.reject(abortError(signal))
  if (!l.busy) {
    l.busy = true
    return Promise.resolve(release)
  }
  if (l.queue.length >= MAX_QUEUED_PER_NODE) return Promise.reject(new NodeBusyError())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const i = l.queue.indexOf(waiter)
      if (i >= 0) l.queue.splice(i, 1)
      reject(abortError(signal))
    }
    // The slot passes straight to this waiter (busy stays true).
    const waiter: Waiter = {
      grant: () => {
        signal.removeEventListener('abort', onAbort)
        resolve(release)
      },
    }
    l.queue.push(waiter)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type Flight = { promise: Promise<unknown>; controller: AbortController; waiters: number; detached: boolean }
const flights = globalSingleton('__piholeHeavyFlights', () => new Map<string, Flight>())

/** Resolve with `promise`, or reject as soon as `signal` aborts (the promise keeps running). */
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

/**
 * Run `fn` as a coalesced call: callers with the same `key` share one run.
 *
 * - `lane`: the node key whose heavy slot the run must hold (omit for calls
 *   that are coalesced but not heavy). `fn` is only invoked once the slot is
 *   held, so any timeout it sets starts then, not while queued.
 * - `signal`: the caller's (request's) signal. The caller stops waiting when
 *   it aborts; the shared run is aborted only when no waiter is left.
 * - `detached`: the run is not tied to any caller (used to fill a cache that
 *   later requests will read). Waiters can still leave; the run carries on.
 */
export function coalesced<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { lane?: string; signal?: AbortSignal; detached?: boolean } = {}
): Promise<T> {
  let flight = flights.get(key)
  if (!flight) {
    const controller = new AbortController()
    const run = async () => {
      if (!opts.lane) return fn(controller.signal)
      const release = await acquire(opts.lane, controller.signal)
      try {
        return await fn(controller.signal)
      } finally {
        release()
      }
    }
    const f: Flight = { promise: run(), controller, waiters: 0, detached: !!opts.detached }
    f.promise.then(
      () => { if (flights.get(key) === f) flights.delete(key) },
      () => { if (flights.get(key) === f) flights.delete(key) }
    )
    flights.set(key, f)
    flight = f
  }
  const f = flight
  f.waiters++
  const signal = opts.signal
  if (signal && !f.detached) {
    const onLeave = () => {
      f.waiters--
      if (f.waiters <= 0) {
        // Nobody wants this result any more: stop the node work, and make sure
        // a later caller starts a fresh run instead of joining an aborted one.
        if (flights.get(key) === f) flights.delete(key)
        f.controller.abort(abortError(signal))
      }
    }
    if (signal.aborted) onLeave()
    else {
      signal.addEventListener('abort', onLeave, { once: true })
      f.promise.then(
        () => signal.removeEventListener('abort', onLeave),
        () => signal.removeEventListener('abort', onLeave)
      )
    }
  }
  return raceSignal(f.promise as Promise<T>, signal)
}

/** True for an error caused by a caller leaving (the response is going nowhere). */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'ResponseAborted')
  )
}
