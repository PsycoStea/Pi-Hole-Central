import { comparePassword } from '@/lib/bcrypt-worker'
import { globalSingleton } from '@/lib/global-state'

/**
 * Password checks cost ~0.5 s of CPU each (cost-12 bcryptjs, pure JS on the one
 * event loop), so unthrottled sign-in attempts starved every other request
 * (audit R2-F1: a viewer's API call went from ~0.05 s to 2-2.5 s with four
 * attempts in flight). Every password check, at sign-in and at
 * /api/users/me/password, now goes through `checkPassword`, which applies:
 *
 * 1. Per-IP limit: after IP_MAX_FAILURES failures inside IP_WINDOW_MS, that IP's
 *    attempts are refused without hashing until the window passes. The IP is
 *    X-Real-IP, which NPM sets; the host firewall lets only NPM reach the app,
 *    so a client cannot choose it.
 * 2. Per-username delay: after USER_FREE_FAILURES consecutive failures for a
 *    username, each attempt first waits (doubling, capped at USER_MAX_DELAY_MS).
 *    A wait, never a lockout, so an attacker cannot lock `admin` out: the right
 *    password still works, just slower. Unknown usernames are tracked the same
 *    way so the delay does not reveal which usernames exist.
 * 3. Global gate: at most GATE_CONCURRENCY hashes at a time, at most GATE_QUEUE
 *    waiting, each for at most GATE_WAIT_MS; beyond that the attempt is refused
 *    without hashing. The hash itself runs in a worker thread
 *    (bcrypt-worker.ts), off the event loop; the gate bounds that worker's
 *    queue.
 *
 * Unknown usernames are compared against a dummy hash (after the gate), so they
 * take as long as a wrong password and the timing does not reveal them either.
 * Accepted trade-off: during an attack, new sign-ins (the owner's too) can be
 * slowed or refused; existing sessions, SSE and the pollers stay responsive.
 */
const IP_WINDOW_MS = 15 * 60_000
const IP_MAX_FAILURES = 20
const USER_FREE_FAILURES = 3
const USER_BASE_DELAY_MS = 1_000
const USER_MAX_DELAY_MS = 15_000
const USER_IDLE_RESET_MS = 15 * 60_000
const GATE_CONCURRENCY = 1
const GATE_QUEUE = 8
const GATE_WAIT_MS = 5_000
// Bound the maps: attacker-chosen usernames and (in theory) IPs are keys.
const MAX_TRACKED = 1_000

// A real cost-12 hash of a random string nobody knows; compared for unknown
// usernames so they cost the same as a wrong password.
const DUMMY_HASH = '$2b$12$L/9knr2d3bBgwDBQrhAUVOM7BgOdCUv6cuexb76yCPMgjv7Y3XIdm'

type IpState = { windowStart: number; failures: number }
type UserState = { failures: number; last: number }

const state = globalSingleton('__piholeCentralLoginGate', () => ({
  ips: new Map<string, IpState>(),
  users: new Map<string, UserState>(),
  active: 0,
  queue: [] as Array<() => void>,
}))

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'wrong' | 'ip_limited' | 'busy' }

export function clientIp(req: Request | undefined): string {
  return req?.headers.get('x-real-ip')?.trim() || 'unknown'
}

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key) // re-insert so iteration order is least-recently-used first
  map.set(key, value)
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value as string)
}

function ipLimited(ip: string, now: number): boolean {
  const s = state.ips.get(ip)
  return !!s && now - s.windowStart < IP_WINDOW_MS && s.failures >= IP_MAX_FAILURES
}

function recordIpFailure(ip: string, now: number) {
  const s = state.ips.get(ip)
  if (!s || now - s.windowStart >= IP_WINDOW_MS) remember(state.ips, ip, { windowStart: now, failures: 1 })
  else remember(state.ips, ip, { ...s, failures: s.failures + 1 })
}

function userDelay(userKey: string, now: number): number {
  const s = state.users.get(userKey)
  if (!s || now - s.last >= USER_IDLE_RESET_MS) return 0
  const over = s.failures - USER_FREE_FAILURES
  if (over < 0) return 0
  return Math.min(USER_BASE_DELAY_MS * 2 ** over, USER_MAX_DELAY_MS)
}

function recordUserFailure(userKey: string, now: number) {
  const s = state.users.get(userKey)
  const failures = s && now - s.last < USER_IDLE_RESET_MS ? s.failures + 1 : 1
  remember(state.users, userKey, { failures, last: now })
}

// Resolves true when a hash slot is ours, false if none freed up in time or the
// queue is full. The caller must call releaseSlot() after a true.
function acquireSlot(): Promise<boolean> {
  if (state.active < GATE_CONCURRENCY) {
    state.active++
    return Promise.resolve(true)
  }
  if (state.queue.length >= GATE_QUEUE) return Promise.resolve(false)
  return new Promise((resolve) => {
    const grant = () => { clearTimeout(timer); state.active++; resolve(true) }
    const timer = setTimeout(() => {
      const i = state.queue.indexOf(grant)
      if (i >= 0) state.queue.splice(i, 1)
      resolve(false)
    }, GATE_WAIT_MS)
    state.queue.push(grant)
  })
}

function releaseSlot() {
  state.active--
  const next = state.queue.shift()
  if (next) next()
}

/**
 * Verify `password` against `hash` (null: unknown user, compared against a
 * dummy) for `userKey` (lowercased username or user id) from `ip`.
 */
export async function checkPassword(
  password: string,
  hash: string | null,
  userKey: string,
  ip: string,
): Promise<PasswordCheck> {
  if (ipLimited(ip, Date.now())) return { ok: false, reason: 'ip_limited' }

  const delay = userDelay(userKey, Date.now())
  if (delay > 0) await new Promise((r) => setTimeout(r, delay))

  if (!(await acquireSlot())) {
    recordIpFailure(ip, Date.now())
    return { ok: false, reason: 'busy' }
  }
  let valid: boolean
  try {
    valid = await comparePassword(password, hash ?? DUMMY_HASH)
  } catch (err) {
    // Fail closed: a worker error is a refused attempt, never a match.
    console.error('[auth] password check failed:', (err as Error).message)
    return { ok: false, reason: 'busy' }
  } finally {
    releaseSlot()
  }

  const now = Date.now()
  if (valid && hash !== null) {
    state.users.delete(userKey)
    return { ok: true }
  }
  recordUserFailure(userKey, now)
  recordIpFailure(ip, now)
  return { ok: false, reason: 'wrong' }
}
