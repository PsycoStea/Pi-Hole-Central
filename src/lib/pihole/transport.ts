import { readFileSync } from 'fs'
import { connect as tlsConnect } from 'tls'
import { isIP } from 'net'
import { Agent, fetch, FormData } from 'undici'
import type { RequestInit, Response } from 'undici'

/**
 * Every request to a Pi-hole node goes through nodeFetch (FIX-PLAN P4.4).
 *
 * - https nodes are verified against ONE private CA (PIHOLE_CA_FILE) and
 *   nothing else: the Agent's `ca` replaces the system trust store, so a
 *   publicly-trusted certificate for the node's address is refused too.
 *   Without a CA file, https nodes are refused outright rather than trusted
 *   blindly. http nodes are unaffected, with or without a CA file.
 * - Redirects are never followed (R3A-NV4): a node, or whoever answers at its
 *   address, could otherwise send the app's X-FTL-SID or password to any URL.
 *   A 3xx comes back as an error to the caller.
 *
 * undici's own fetch (pinned dependency, external in next.config) is used for
 * http too, so both schemes share one code path. Bodies built for it must use
 * undici's FormData, re-exported here: the global FormData belongs to Node's
 * bundled undici and is not guaranteed to serialise through this one.
 */

export { FormData }
export type { Response as NodeResponse }

const CA_ENV = 'PIHOLE_CA_FILE'

let httpsAgent: Agent | null = null
let caPem: Buffer | null = null
let caError: string | null = null

/** The CA every https node is verified against. Throws NodeCaConfigError when unset/unreadable. */
function getCa(): Buffer {
  if (caPem) return caPem
  if (caError) throw new NodeCaConfigError(caError)
  const path = process.env[CA_ENV]
  let ca: Buffer | null = null
  if (path) {
    try {
      ca = readFileSync(path)
    } catch {
      ca = null
    }
  }
  if (!ca || !ca.toString('utf8').includes('-----BEGIN CERTIFICATE-----')) {
    // Sticky: the mount does not change while the process runs.
    caError =
      `https Pi-hole nodes need a CA certificate: set ${CA_ENV} to a readable PEM file ` +
      '(see docker-compose.yml PIHOLE_CA_PATH). Refusing to fall back to the system trust store.'
    throw new NodeCaConfigError(caError)
  }
  caPem = ca
  return ca
}

function getHttpsAgent(): Agent {
  if (httpsAgent) return httpsAgent
  httpsAgent = new Agent({
    connect: { ca: getCa(), rejectUnauthorized: true },
    // undici's defaults (4 s idle close, client sends FIN first) were checked
    // against FTL v6.8 on 2026-11-14: no CLOSE-WAIT left behind on the node
    // (research-pihole-ftl-closewaitleak was FTL v6.6.2 + nebula-sync).
    keepAliveTimeout: 4_000,
    // No per-node connection cap, same as the http path (undici's global
    // dispatcher). Slow calls are normal here: 30-day history takes up to
    // 60 s on .16 and gravity/Teleporter hold a connection for long, and the
    // callers' AbortSignal.timeout starts while a request is still queued for
    // a free connection, so a small cap made fast calls time out behind slow
    // ones. FTL runs webserver.threads=100.
  })
  return httpsAgent
}

export class NodeRedirectError extends Error {
  constructor(status: number) {
    super(`Pi-hole node answered with a redirect (HTTP ${status}); redirects are not followed`)
    this.name = 'NodeRedirectError'
  }
}

export type NodeFetchInit = Omit<RequestInit, 'redirect' | 'dispatcher'>

/** fetch() for Pi-hole node URLs only. See the module comment. */
export async function nodeFetch(url: string, init: NodeFetchInit = {}): Promise<Response> {
  const protocol = new URL(url).protocol
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`Refusing non-http(s) Pi-hole URL scheme ${protocol}`)
  }
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    ...(protocol === 'https:' ? { dispatcher: getHttpsAgent() } : {}),
  })
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {})
    throw new NodeRedirectError(res.status)
  }
  return res
}

export class NodeCaConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NodeCaConfigError'
  }
}

// TLS verification failures from Node's tls layer (surfaced as err.cause.code).
const TLS_VERIFY_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/**
 * True when nodeFetch failed for a reason that proves something answered at
 * the node's address, or that is our own configuration: a redirect, a TLS
 * certificate that does not verify, or a missing CA file. Restarting FTL or
 * rebooting the node cannot fix any of these, so SSH recovery must not try.
 */
export function isNodeAnsweringError(err: unknown): boolean {
  if (err instanceof NodeRedirectError || err instanceof NodeCaConfigError) return true
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof code === 'string' && TLS_VERIFY_CODES.has(code)
}

export type NodeCertStatus = {
  /** The certificate verifies against the CA and matches the URL's host. */
  verified: boolean
  /** Node's TLS error code when it does not verify (e.g. CERT_HAS_EXPIRED). */
  verifyError: string | null
  notAfter: Date
  daysLeft: number
}

/**
 * One TLS handshake to an https node, to read its certificate's expiry
 * (FIX-PLAN P4.5): FTL never renews a certificate it did not issue, so the
 * private-CA certs on the nodes simply lapse. Verification is evaluated, not
 * enforced, so an expired or wrong certificate is reported instead of hidden
 * behind a handshake error. Throws for http URLs, a missing CA, or a node that
 * does not complete a handshake (the offline alerts cover that case).
 */
export function checkNodeCert(url: string, timeoutMs = 10_000): Promise<NodeCertStatus> {
  const u = new URL(url)
  if (u.protocol !== 'https:') return Promise.reject(new Error('not an https node URL'))
  const ca = getCa()
  const host = u.hostname
  const port = Number(u.port || 443)
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      ca,
      // Evaluate, don't enforce: Node still runs the chain check and the
      // host/IP identity check and reports them via authorized/authorizationError.
      rejectUnauthorized: false,
      ...(isIP(host) ? {} : { servername: host }),
    })
    const done = (fn: () => void) => {
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error(`TLS handshake to ${host}:${port} timed out`))), timeoutMs)
    socket.once('error', (err) => done(() => reject(err)))
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const notAfter = new Date(cert?.valid_to ?? NaN)
      if (!cert || Number.isNaN(notAfter.getTime())) {
        return done(() => reject(new Error(`${host}:${port} sent no readable certificate`)))
      }
      const authErr = socket.authorizationError as unknown
      const verifyError = socket.authorized
        ? null
        : String((authErr as { code?: string } | null)?.code ?? authErr ?? 'unknown')
      done(() =>
        resolve({
          verified: socket.authorized,
          verifyError,
          notAfter,
          daysLeft: Math.floor((notAfter.getTime() - Date.now()) / 86_400_000),
        })
      )
    })
  })
}
