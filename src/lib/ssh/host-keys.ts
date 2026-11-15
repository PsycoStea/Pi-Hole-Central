import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { appSettings, instances } from '@/lib/db/schema'
import { eq, like } from 'drizzle-orm'
import { notifyCondition } from '@/lib/notifications/center'

// SSH host-key pinning (trust on first use).
//
// Until now every SSH connection (recovery restarts, reboots, pihole -up, the
// watchdog, Unbound, the nebula-sync host) accepted whatever host key the far
// end presented, so anything answering on a node's IP could receive the SSH
// password or run as the trusted host. Now the first key seen for a host is
// pinned, and any later connection presenting a different key is refused.
//
// Pins are per HOST (not per instance): the nebula-sync host is not an
// instance, and two instances could share a host. Stored in app_settings as
// `ssh_host_key:<host>` -> JSON { alg, fp, firstSeen }, with fp in OpenSSH's
// format (SHA256:<base64, no padding>), so a pin can be checked by hand with
// `ssh-keyscan -t <alg> <host> | ssh-keygen -lf -`.
//
// A legitimate key change (node reinstalled) is cleared with "Forget" on
// Settings -> Instances, which deletes the pin; the next connection re-pins.

const PREFIX = 'ssh_host_key:'
export const HOST_KEY_ALERT = 'ssh_host_key'

export type HostKeyPin = { host: string; alg: string; fp: string; firstSeen: string }

/** OpenSSH-style fingerprint and key type of a raw SSH public key blob. */
export function describeKey(blob: Buffer): { alg: string; fp: string } {
  const len = blob.readUInt32BE(0)
  const alg = blob.subarray(4, 4 + len).toString('ascii')
  const fp = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return { alg, fp }
}

export async function readPin(host: string): Promise<HostKeyPin | null> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, PREFIX + host) })
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as Omit<HostKeyPin, 'host'>
    return { host, ...v }
  } catch {
    return null
  }
}

export async function listPins(): Promise<HostKeyPin[]> {
  const rows = await db.query.appSettings.findMany({ where: like(appSettings.key, `${PREFIX}%`) })
  return rows
    .map((r) => {
      try {
        return { host: r.key.slice(PREFIX.length), ...(JSON.parse(r.value) as Omit<HostKeyPin, 'host'>) }
      } catch {
        return null
      }
    })
    .filter((p): p is HostKeyPin => p !== null)
    .sort((a, b) => a.host.localeCompare(b.host))
}

/** Delete a pin and clear its alert; the next connection to the host re-pins. */
export async function forgetPin(host: string): Promise<boolean> {
  const existed = (await readPin(host)) !== null
  await db.delete(appSettings).where(eq(appSettings.key, PREFIX + host))
  await notifyCondition({
    type: HOST_KEY_ALERT,
    instanceId: await instanceIdForHost(host),
    severity: 'critical',
    title: 'SSH host key changed',
    active: false,
  })
  return existed
}

/** The instance on this host, if any, so the alert is attached to it. */
async function instanceIdForHost(host: string): Promise<string | null> {
  const rows = await db.query.instances.findMany()
  return rows.find((r) => {
    try {
      return new URL(r.url).hostname === host
    } catch {
      return false
    }
  })?.id ?? null
}

export class HostKeyMismatchError extends Error {
  constructor(public host: string, public pinned: HostKeyPin, public presented: { alg: string; fp: string }) {
    super(
      `SSH host key for ${host} has changed: pinned ${pinned.alg} ${pinned.fp} (since ${pinned.firstSeen.slice(0, 10)}), ` +
        `presented ${presented.alg} ${presented.fp}. Connection refused. If the node was reinstalled, ` +
        `check the new key and use Forget on Settings → Instances → SSH host keys.`
    )
    this.name = 'HostKeyMismatchError'
  }
}

/**
 * Host-key algorithms to offer for a pinned host: only the pinned key's type,
 * so the server must present that key. Without this, a server (or an impostor)
 * could offer a different key type, which has no pin to compare against.
 * `undefined` = not pinned yet, use ssh2's defaults.
 */
export function hostKeyAlgorithmsFor(pin: HostKeyPin | null): string[] | undefined {
  if (!pin) return undefined
  // An RSA key's blob type is ssh-rsa, but it is negotiated as one of these.
  if (pin.alg === 'ssh-rsa') return ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
  return [pin.alg]
}

/**
 * Build an ssh2 hostVerifier for `host`. `onMismatch` receives the details so
 * the caller can throw a clear error after ssh2's generic "Host denied".
 *
 * First use: insert-if-absent, then re-read and compare, so two connections
 * racing on first use (health, recovery, watchdog and Unbound all connect within
 * the same minute after a deploy) cannot both "win" with different keys.
 */
export function makeHostVerifier(host: string, onMismatch: (e: HostKeyMismatchError) => void) {
  return (blob: Buffer, verify: (ok: boolean) => void): void => {
    const presented = describeKey(blob)
    ;(async () => {
      let pin = await readPin(host)
      if (!pin) {
        const value = JSON.stringify({ alg: presented.alg, fp: presented.fp, firstSeen: new Date().toISOString() })
        await db.insert(appSettings).values({ key: PREFIX + host, value }).onConflictDoNothing()
        pin = await readPin(host)
        if (pin && pin.fp === presented.fp) console.log(`[ssh] pinned ${host} host key ${presented.alg} ${presented.fp}`)
      }
      // connectSSH restricts negotiation to the pinned key type, so a different
      // fingerprint here really is a different key for the same type.
      if (pin && pin.fp === presented.fp) return verify(true)
      const err = new HostKeyMismatchError(host, pin!, presented)
      onMismatch(err)
      await notifyCondition({
        type: HOST_KEY_ALERT,
        instanceId: await instanceIdForHost(host),
        severity: 'critical',
        title: 'SSH host key changed',
        message: err.message,
        active: true,
      })
      verify(false)
    })().catch((e) => {
      // Never fail open: if the pin can't be read or written, refuse.
      console.error(`[ssh] host key check for ${host} failed, refusing connection:`, e)
      verify(false)
    })
  }
}
