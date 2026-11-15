import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { notifyCondition, type Severity } from '@/lib/notifications/center'
import { checkNodeCert, NodeCaConfigError } from '@/lib/pihole/transport'
import { globalSingleton } from '@/lib/global-state'
import { errMsg } from '@/lib/errors'

/**
 * Expiry alert for the nodes' own https certificates (FIX-PLAN P4.5).
 *
 * The nodes serve certificates from your own CA (PIHOLE_CA_PATH), which FTL never
 * renews (it only regenerates certificates it issued itself), so without this
 * they would lapse silently and every https call to the node would start
 * failing on that day. Separate from `cert_expiry`, which tracks the Unbound
 * DoT upstream's certificate over SSH: both keep one live row per node, so
 * sharing the type would make each check resolve the other's alert.
 */
export const NODE_CERT_ALERT = 'node_tls_cert'
export const NODE_CERT_WARN_DAYS = 30
export const NODE_CERT_CRIT_DAYS = 7
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const state = globalSingleton('__piholeNodeCertCheck', () => ({ lastRun: new Map<string, number>() }))

export async function runNodeCertChecks(): Promise<void> {
  const enabled = await db.query.instances.findMany({ where: eq(instances.enabled, true) })
  for (const instance of enabled) {
    const last = state.lastRun.get(instance.id) ?? 0
    if (Date.now() - last < CHECK_INTERVAL_MS) continue
    state.lastRun.set(instance.id, Date.now())

    const base = { type: NODE_CERT_ALERT, title: `Node HTTPS Certificate: ${instance.name}`, instanceId: instance.id }
    if (!instance.url.startsWith('https:')) {
      // An http node uses no certificate here: clear anything left from when it was https.
      await notifyCondition({ ...base, severity: 'warning', active: false })
      continue
    }
    try {
      const cert = await checkNodeCert(instance.url)
      const date = cert.notAfter.toISOString().slice(0, 10)
      let severity: Severity | null = null
      let message = `${instance.name}'s certificate expires ${date} (${cert.daysLeft} days).`
      if (!cert.verified) {
        severity = 'critical'
        message =
          `${instance.name}'s certificate does not verify against the configured CA (${cert.verifyError}); ` +
          `the app cannot reach the node over https. Certificate expiry: ${date}.`
      } else if (cert.daysLeft < NODE_CERT_CRIT_DAYS) {
        severity = 'critical'
        message += ` Renew it now: FTL will not renew a certificate from your own CA, and https to the node stops when it lapses.`
      } else if (cert.daysLeft < NODE_CERT_WARN_DAYS) {
        severity = 'warning'
        message += ` Issue a new one from your CA and install it on the node before then.`
      }
      // daysLeft only falls until the cert is replaced, which jumps it far
      // past the warning window, so no hysteresis band is needed.
      await notifyCondition({ ...base, severity: severity ?? 'warning', message, active: severity !== null })
    } catch (err) {
      if (err instanceof NodeCaConfigError) {
        console.error(`[node-cert] ${instance.name}: ${err.message}`)
      } else {
        // No handshake at all: the node is down or not serving TLS. The
        // offline/recovery alerts own that state; leave this condition as is
        // and try again on the next poll rather than in a day.
        state.lastRun.delete(instance.id)
        console.error(`[node-cert] ${instance.name}: TLS check failed: ${errMsg(err)}`)
      }
    }
  }
}
