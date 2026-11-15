import { NodeSSH } from 'node-ssh'
import { readFileSync } from 'fs'
import { decrypt } from '@/lib/crypto'
import { HostKeyMismatchError, hostKeyAlgorithmsFor, makeHostVerifier, readPin } from '@/lib/ssh/host-keys'

export type SSHConfig = {
  host: string
  username: string
  passwordEncrypted?: string | null
  /** Defaults to SSH_PORT (set only by the e2e lab) or 22. */
  port?: number
}

export function extractHost(url: string): string {
  return new URL(url).hostname
}

// Every remote command gets a deadline. ssh2's readyTimeout only covers the
// handshake: a command that hangs afterwards (a Pi Zero stalled on SD-card I/O,
// a wedged systemctl) would otherwise never return, its caller's `finally
// { ssh.dispose() }` would never run, and the every-minute loops would stack a
// new session on top each tick until sshd refused connections.
const DEFAULT_EXEC_TIMEOUT_MS = 90_000

export type ConnectOptions = {
  /** Per-command deadline. Raise it only for genuinely long jobs (pihole -up). */
  execTimeoutMs?: number
}

export async function connectSSH(config: SSHConfig, opts: ConnectOptions = {}): Promise<NodeSSH> {
  const ssh = new NodeSSH()
  const keyPath = process.env.SSH_KEY_PATH

  // Host-key pinning (see host-keys.ts): offer only the pinned key type and
  // refuse a different key. Checked before any credential is sent.
  const pin = await readPin(config.host)
  let mismatch: HostKeyMismatchError | null = null
  const connectOpts: Parameters<NodeSSH['connect']>[0] = {
    host: config.host,
    port: config.port ?? (Number(process.env.SSH_PORT) || 22),
    hostVerifier: makeHostVerifier(config.host, (e) => { mismatch = e }),
    ...(pin ? { algorithms: { serverHostKey: hostKeyAlgorithmsFor(pin) as never } } : {}),
    username: config.username,
    readyTimeout: 15_000,
    // Detect a dead peer (node rebooted, Wi-Fi dropped) instead of waiting on a
    // half-open TCP connection forever.
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
  }

  if (keyPath && keyPath !== '/dev/null') {
    try {
      connectOpts.privateKey = readFileSync(keyPath, 'utf8')
      const passphrase = process.env.SSH_KEY_PASSPHRASE
      if (passphrase) connectOpts.passphrase = passphrase
    } catch {
      // Key file unreadable — fall through to password
    }
  }

  if (!connectOpts.privateKey && config.passwordEncrypted) {
    connectOpts.password = decrypt(config.passwordEncrypted)
  }

  if (!connectOpts.privateKey && !connectOpts.password) {
    throw new Error(
      'No SSH auth method available: set SSH_KEY_PATH env var or configure an SSH password for this instance'
    )
  }

  try {
    await ssh.connect(connectOpts)
  } catch (err) {
    if (mismatch) throw mismatch
    // Pinned to one key type and the server no longer offers it: that is a key
    // change too (e.g. reinstalled without an ed25519 key), not "unreachable".
    if (pin && /host key|hostkey/i.test(String(err))) {
      throw new Error(
        `SSH host key for ${config.host}: the server no longer offers the pinned ${pin.alg} key (${pin.fp}). ` +
          `If the node was reinstalled, check the new key and use Forget on Settings → Instances → SSH host keys. (${String(err)})`
      )
    }
    throw err
  }

  const timeoutMs = opts.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const exec = ssh.execCommand.bind(ssh)
  ssh.execCommand = (command, options) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Tear the whole connection down: the hung channel can't be reused and
        // disposing is what releases the session slot on the node.
        ssh.dispose()
        reject(new Error(`SSH command timed out after ${timeoutMs / 1000}s on ${config.host}: ${command.slice(0, 60)}`))
      }, timeoutMs)
    })
    return Promise.race([exec(command, options), deadline]).finally(() => clearTimeout(timer))
  }
  return ssh
}

export async function isFTLRunning(ssh: NodeSSH): Promise<boolean> {
  const result = await ssh.execCommand('systemctl is-active pihole-FTL')
  return result.code === 0
}

export async function restartFTL(ssh: NodeSSH): Promise<number> {
  const result = await ssh.execCommand('sudo systemctl restart pihole-FTL')
  return result.code ?? -1
}

/**
 * CLOSE-WAIT sockets on FTL's web ports (audit P5.6 / R2-NV5).
 *
 * Counts :443 as well as :80: since P4 every client (this app, nebula-sync,
 * NPM) talks to the nodes over https, so an :80-only count could no longer see
 * the leak at all. Sockets are attributed to FTL by port, not with `ss -p`: the
 * SSH user may not run `ss` as root (sudoers allows only systemctl, reboot,
 * pihole, unbound-control), and on Pi-hole v6 FTL is the only listener on
 * 80/443 (there is no lighttpd any more).
 */
export async function getCloseWaitCount(ssh: NodeSSH): Promise<number> {
  const result = await ssh.execCommand(
    "ss -tn state close-wait '( sport = :80 or sport = :443 )' | awk 'NR>1 {c++} END {print c+0}'"
  )
  const n = parseInt(result.stdout.trim(), 10)
  return isNaN(n) ? 0 : n
}

export type NodeLocalStatus = {
  /** 'down' ONLY when curl on the node itself got no HTTP status at all. */
  api: 'up' | 'down' | 'unknown'
  /** 'up' when the node's own resolver answered (any status), 'down' when it did not. */
  dns: 'up' | 'down' | 'unknown'
  detail: string
}

const HTTP_MARK = '__PC_LOCAL_HTTP__='
const DNS_MARK = '__PC_LOCAL_DNS__='

/**
 * Ask the node itself whether FTL's API and DNS answer (audit P5.5 / R2-NV4).
 *
 * Recovery used to restart FTL and reboot the node on the app's own view
 * alone: an app-side stall or a path problem looked exactly like a dead node.
 * This runs over the SSH session recovery already has open. Fail-safe: only a
 * positive "no HTTP status" from the node's loopback counts as down; anything
 * missing or unparseable is 'unknown', and callers treat that as "do not act".
 * Any HTTP status, 3xx/4xx included, means the API is answering.
 */
export async function nodeLocalCheck(ssh: NodeSSH): Promise<NodeLocalStatus> {
  const cmd =
    "h=$(curl -sk -m 3 -o /dev/null -w '%{http_code}' https://127.0.0.1/api/info/login 2>/dev/null); " +
    "case \"$h\" in ''|000) h=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1/api/info/login 2>/dev/null);; esac; " +
    `echo "${HTTP_MARK}\${h:-000}"; ` +
    "s=$(dig +time=2 +tries=1 @127.0.0.1 pi.hole A 2>/dev/null | sed -n 's/.*status: \\([A-Z]*\\).*/\\1/p' | head -1); " +
    `echo "${DNS_MARK}\${s:-NONE}"`
  let stdout = ''
  try {
    stdout = (await ssh.execCommand(cmd)).stdout
  } catch (err) {
    return { api: 'unknown', dns: 'unknown', detail: `local check failed: ${(err as Error).message}` }
  }
  const http = new RegExp(`${HTTP_MARK}(\\d{3})`).exec(stdout)?.[1]
  const dnsStatus = new RegExp(`${DNS_MARK}([A-Z]+)`).exec(stdout)?.[1]
  const api: NodeLocalStatus['api'] = http === undefined ? 'unknown' : http === '000' ? 'down' : 'up'
  const dns: NodeLocalStatus['dns'] = dnsStatus === undefined ? 'unknown' : dnsStatus === 'NONE' ? 'down' : 'up'
  return { api, dns, detail: `local HTTP ${http ?? '?'}, local DNS ${dnsStatus ?? '?'}` }
}

export async function rebootDevice(ssh: NodeSSH): Promise<void> {
  await ssh.execCommand('sudo reboot').catch(() => {
    // Expected: connection drops before the command responds
  })
}

export async function runUpdate(
  ssh: NodeSSH
): Promise<{ code: number; stdout: string; stderr: string }> {
  // `pihole -up` re-execs itself with sudo; run it via `sudo -n` so a missing
  // NOPASSWD sudoers entry fails fast with a clear error instead of hanging on
  // a password prompt. Requires a sudoers rule permitting /usr/local/bin/pihole
  // for the SSH user on the node.
  const result = await ssh.execCommand('sudo -n pihole -up')
  return { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr }
}
