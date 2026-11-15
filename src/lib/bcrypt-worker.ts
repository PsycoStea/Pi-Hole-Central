import { Worker } from 'node:worker_threads'
import bcrypt from 'bcryptjs'
import { globalSingleton } from '@/lib/global-state'

/**
 * bcrypt off the event loop (audit R2-F1). bcryptjs is pure JS and, run on the
 * main thread, yields only every 100 ms: every turn of the event loop then
 * carries a 100 ms chunk, and a request that needs ~20 turns took ~2.4 s even
 * with only one hash in flight (lab, 2026-11-14). Here hashes run in one worker
 * thread, so the main thread never runs bcrypt rounds.
 *
 * Failure handling is fail-CLOSED per request: a worker error, crash or timeout
 * rejects, and callers treat that as a refused attempt, never a match. If the
 * worker cannot start at all (bcryptjs not resolvable from the app directory),
 * hashing falls back to the main thread so sign-in keeps working, and says so
 * loudly in the log: that fallback brings the slowdown back.
 *
 * bcryptjs is in serverExternalPackages so both bundlers leave it in
 * node_modules, where the worker resolves it from the app's directory (the
 * resolution lives in the worker's source string: webpack rewrites a
 * createRequire().resolve() in bundled code into a numeric module id).
 */
const TIMEOUT_MS = 10_000

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
// Resolved here, inside a string, so no bundler rewrites it into a module id.
const bcrypt = require('node:module').createRequire(process.cwd() + '/noop.js')('bcryptjs')
parentPort.postMessage({ ready: true })
parentPort.on('message', (m) => {
  try {
    const result = m.op === 'compare'
      ? bcrypt.compareSync(m.password, m.hash)
      : bcrypt.hashSync(m.password, m.rounds)
    parentPort.postMessage({ id: m.id, result })
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) })
  }
})
`

type Msg = { op: 'compare'; password: string; hash: string } | { op: 'hash'; password: string; rounds: number }
type Pending = { msg: Msg; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

const st = globalSingleton('__piholeCentralBcryptWorker', () => ({
  worker: null as Worker | null,
  ready: false,
  inline: false,
  nextId: 1,
  pending: new Map<number, Pending>(),
}))

function inline(msg: Msg): Promise<unknown> {
  return msg.op === 'compare' ? bcrypt.compare(msg.password, msg.hash) : bcrypt.hash(msg.password, msg.rounds)
}

// A worker that never became ready has compared nothing, so its queued requests
// can safely run on the main thread instead of being refused.
function rerunAllInline() {
  for (const [id, p] of st.pending) {
    clearTimeout(p.timer)
    st.pending.delete(id)
    inline(p.msg).then(p.resolve, p.reject)
  }
}

function failAll(reason: string) {
  for (const [id, p] of st.pending) {
    clearTimeout(p.timer)
    p.reject(new Error(reason))
    st.pending.delete(id)
  }
}

function useInline(why: string) {
  if (!st.inline) {
    console.error(`[auth] password worker unavailable (${why}); hashing on the main thread, so sign-in attempts can slow the dashboard (R2-F1)`)
  }
  st.inline = true
}

function getWorker(): Worker | null {
  if (st.inline) return null
  if (st.worker) return st.worker
  let w: Worker
  try {
    w = new Worker(WORKER_SOURCE, { eval: true })
  } catch (err) {
    useInline(`could not start: ${(err as Error).message}`)
    return null
  }
  w.unref() // never keeps a stopping process alive
  st.worker = w
  st.ready = false
  w.on('message', (m: { ready?: boolean; id?: number; result?: unknown; error?: string }) => {
    if (m.ready) {
      if (!st.ready) console.log('[auth] password hashing runs in a worker thread')
      st.ready = true
      return
    }
    const p = m.id !== undefined ? st.pending.get(m.id) : undefined
    if (!p) return
    st.pending.delete(m.id!)
    clearTimeout(p.timer)
    if (m.error !== undefined) p.reject(new Error(m.error))
    else p.resolve(m.result)
  })
  const gone = (why: string) => {
    if (st.worker !== w) return
    const neverStarted = !st.ready
    st.worker = null
    if (neverStarted) {
      // It will not get better on retry: switch to the main thread for good.
      useInline(`worker failed to start: ${why}`)
      rerunAllInline()
    } else {
      failAll(`password worker ${why}`) // mid-flight: fail closed
    }
  }
  w.on('error', (err) => gone(`error: ${err.message}`))
  w.on('exit', (code) => gone(`exited with code ${code}`))
  return w
}

function run(msg: Msg): Promise<unknown> {
  const w = getWorker()
  if (!w) return inline(msg)
  const id = st.nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      st.pending.delete(id)
      reject(new Error('password worker timed out'))
      // A stuck worker is replaced; its other requests fail closed.
      if (st.worker === w) { st.worker = null; failAll('password worker restarted'); void w.terminate() }
    }, TIMEOUT_MS)
    st.pending.set(id, { msg, resolve, reject, timer })
    w.postMessage({ id, ...msg })
  })
}

/** Rejects on any worker failure: callers must treat that as "no match". */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return (await run({ op: 'compare', password, hash })) === true
}

export async function hashPassword(password: string, rounds = 12): Promise<string> {
  const h = await run({ op: 'hash', password, rounds })
  if (typeof h !== 'string') throw new Error('password worker returned no hash')
  return h
}
