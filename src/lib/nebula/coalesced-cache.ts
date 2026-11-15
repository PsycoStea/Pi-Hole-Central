import { globalSingleton } from '@/lib/global-state'

// A single-slot result cache for expensive status reads (SSH to the nebula host,
// six Pi-hole GETs per node) that:
//   - serves the cached value for `ttlMs` to ordinary reads;
//   - lets a forced read (Refresh) recompute only once `minRefreshMs` has passed
//     since the last result, so hammering Refresh cannot fan out (audit R2-NV1);
//   - coalesces: while a computation is running, every caller (forced or not)
//     waits on that same promise, so there is never more than one in flight;
//   - is keyed: a result computed for a different `key` (e.g. the nebula host
//     settings changed) is never served, and the min interval does not apply
//     to it, so a settings change shows up on the next read.
//
// The shared computation is deliberately not tied to any caller's
// AbortSignal: other callers are waiting on it, and one client disconnecting
// must not cancel it for them. It is bounded instead by the min interval and by
// the deadlines inside the computation itself.
export type CoalescedCache<T> = {
  get(key: string, force: boolean, compute: () => Promise<T>): Promise<T>
}

type Slot<T> = {
  value: T | null
  key: string
  at: number
  inflight: Promise<T> | null
  inflightKey: string
}

export function coalescedCache<T>(
  globalKey: string,
  opts: { ttlMs: number; minRefreshMs: number }
): CoalescedCache<T> {
  const s = globalSingleton<Slot<T>>(globalKey, () => ({ value: null, key: '', at: 0, inflight: null, inflightKey: '' }))

  return {
    async get(key, force, compute) {
      for (;;) {
        if (s.value !== null && s.key === key) {
          const age = Date.now() - s.at
          if (age < (force ? opts.minRefreshMs : opts.ttlMs)) return s.value
        }
        if (s.inflight) {
          if (s.inflightKey === key) return s.inflight
          // A computation for an older key is still running: let it finish
          // (one at a time), then look again.
          await s.inflight.catch(() => {})
          continue
        }
        const p: Promise<T> = compute()
          .then((v) => {
            s.value = v
            s.key = key
            s.at = Date.now()
            return v
          })
          .finally(() => {
            if (s.inflight === p) s.inflight = null
          })
        s.inflight = p
        s.inflightKey = key
        return p
      }
    },
  }
}
