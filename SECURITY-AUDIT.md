# Security audit and fix pass

Pi-Hole Central was audited in November 2026 with the open-source [security-audit skill from Cloudflare](https://github.com/cloudflare/security-audit-skill) (commit `c1c8a8c`), run by Claude Code agents under the maintainer's direction, and every result was then fixed and re-tested. This file lists every record the audit produced and how it was closed. It is a self-run audit, not a third-party penetration test.

## How the audit worked

- **Five scoped runs**, each with its own budget of agents:
  - Run 1: Unauthenticated surface, sign-in and sessions, viewer-to-admin authorization on every API route, live event stream, users, audit log.
  - Run 2: SSH command construction and host keys, Pi-hole API path building, background jobs (poller, recovery, watchdog, DNS schedules).
  - Run 3A: Secrets at rest and in transit, SSRF and other outbound requests.
  - Run 3B: Backups and restore, rendering, audit log, nebula-sync parsing.
  - Run 4: Build, deploy and supply chain.
- **Hunters, verifiers, critics.** Hunter agents looked for issues; independent verifier agents had to **reproduce** each candidate in an isolated lab (no network access, a read-only copy of the code, mock Pi-hole and SSH servers) before it counted; critic passes looked for areas the hunters missed. Leads that only a real deployment could settle were checked read-only against the live system.
- **Verdicts are never edited afterwards.** "Confirmed" = reproduced; "Lead, checked" = needed a live check, then fixed; "Rejected" = the reproduction or the threat model did not hold.

## How the fixes were verified

- Each fix shipped with a **lab check that fails on the old code and passes on the new one**, and a **live check** after it was deployed.
- Fixes were deployed in phases with a pinned, SHA-verified deploy and a database backup before each one.
- A **final regression run** on the released code: 275 lab assertions, 0 failures. Automatic recovery was also tested live on a real Pi-hole node (FTL stopped, network path cut, update in progress).

**Totals:** 42 records: 21 confirmed findings (2 Medium, 19 Low; none Critical or High), 15 leads, 6 rejected. Every confirmed finding and lead is fixed; two rejected items were hardened anyway. **None is open.**

## Run 1: Unauthenticated surface, sign-in and sessions, viewer-to-admin authorization on every API route, live event stream, users, audit log

| ID | Verdict | Finding (as recorded) | Status | Fix |
|---|---|---|---|---|
| R1-NV1 | Lead, checked | Admin API POST routes accept text/plain requests from other origins on the same site, because SameSite=Lax is the only CSRF control | Hardened | State-changing API calls and the live stream now require a same-origin request (Sec-Fetch-Site / Origin); cross-site requests get 403. |
| R1-NV2 | Lead, checked | Session cookie is non-Secure and host-only on the bare IP, so any other HTTP service on that IP can read or replace it, and it travels in cleartext | Fixed | Run behind an HTTPS reverse proxy with Secure `__Host-`/`__Secure-` cookies, the app port firewalled to the proxy, and the proxy-to-app hop also on TLS with CA verification (see README). |
| R1-F2 | Confirmed (Low) | SSE live stream keeps sending data to a user after the app deletes them | Fixed | The live stream ends when the user is deleted or their session is revoked (re-checked every 30 s). |
| R1-F3 | Confirmed (Low) | Settings and watchdog PUT save earlier fields, then return 400; the settings change gets no audit row, including from the shipped Sync page save | Fixed | The whole body is validated first, written in one transaction, then audited; malformed JSON returns 400 with nothing saved. |
| R1-F4 | Confirmed (Low) | Audit log records a caller-chosen IP address from X-Forwarded-For | Fixed | The audit IP comes only from the proxy-set `X-Real-IP`, never from `X-Forwarded-For`. |
| R1-F5 | Confirmed (Low) | Security-relevant changes (watchdog, notification channels, alert settings, own password, Unbound actions, sign-ins) leave no audit-log row | Fixed | All security-relevant changes and every sign-in (success and failure) are audited; failed-sign-in rows are capped so they cannot flood the log. |
| R1-F1 | Confirmed (Medium) | Captured session tokens stay valid after password change, admin password reset and sign-out (stateless JWT with no credential binding) | Fixed | Each user has a token version carried in the session: password change, admin reset, demotion and sign-out end every session that user has. |
| R1-F6 | Confirmed (Low) | User PATCH commits a role change before validating the password, then returns 400 without an audit record | Fixed | Role and password changes are validated before anything is saved, then applied and audited together. |

## Run 2: SSH command construction and host keys, Pi-hole API path building, background jobs (poller, recovery, watchdog, DNS schedules)

| ID | Verdict | Finding (as recorded) | Status | Fix |
|---|---|---|---|---|
| R2-F2 | Confirmed (Low) | Instance URL change keeps the stored SSH password and sends it to the new host, which is pinned on first use | Fixed | Changing an instance's host clears its stored SSH password. |
| — | Rejected | Admin API POST routes accept text/plain requests from other origins on the same site, because SameSite=Lax is the only CSRF control (no same-site attacker origin exists on the live access path) | No change | Not a vulnerability (reproduction or threat model did not hold). |
| R2-F3 | Confirmed (Low) | Admin session cookie and login password travel in cleartext over plain HTTP on a flat LAN shared with less-trusted devices, and a captured token replays as admin for up to 30 days | Fixed | As R1-NV2: HTTPS-only access through a reverse proxy, Secure cookies, app port closed to everything but the proxy. |
| R2-F4 | Confirmed (Low) | A viewer can hold any number of non-reading /api/events streams, and each one keeps one more frame in the shared Node process every 30 s with no bound (no backpressure check, no subscriber cap, no stalled-reader timeout) | Fixed | Per-user and per-process stream caps, and nothing is queued to a stream that is not reading, so memory stays flat; a stalled connection itself is closed by the reverse proxy's send timeout. |
| R2-NV1 | Lead, checked | Viewer can force unlimited, uncoalesced root SSH sessions (docker inspect/logs) to the nebula host via /api/nebula/status?refresh=1 | Fixed | Forced refresh is admin-only, refreshes are coalesced with a 10 s minimum interval, and container logs are shown to admins only. |
| R2-F1 | Confirmed (Medium) | Unauthenticated login attempts run cost-12 pure-JS bcrypt on the shared event loop with no rate or concurrency gate | Fixed | Sign-in is gated per address and per user, and password hashing runs in a worker thread instead of the event loop. |
| R2-F5 | Confirmed (Low) | Disabling, deleting or narrowing a DNS schedule mid-window can be overwritten by an in-flight cron evaluation, leaving the window state (e.g. blocking off) applied indefinitely | Fixed | A schedule lock stops an in-flight evaluation from overwriting a schedule that was just disabled, deleted or narrowed. |
| R2-NV2 | Lead, checked | Viewer sessions can keep many uncached, uncancelled live Pi-hole API calls (30-day history, 1000-row query scans) running on the DNS nodes, including admin-disabled ones | Fixed | Long history is cached with in-flight coalescing, heavy node calls are limited to one per node, calls are cancelled when the browser disconnects, disabled nodes get no calls, and query parameters are clamped. |
| R2-F6 | Confirmed (Low) | A dot-only item ('.' or '..') in a Pi-hole API path segment retargets the request, so reverting a temporary regex allow/deny of '.' never removes the stored entry | Fixed | Dot-only path items are rejected before any node call. |
| R2-F7 | Confirmed (Low) | Disabling a Pi-hole instance does not stop an in-flight SSH recovery loop; re-enabling it starts a second concurrent loop | Fixed | Disabling or deleting a node cancels its in-flight recovery at the next step; a re-enable cannot start a second loop. |
| R2-NV3 | Lead, checked | No per-node operation lock between an admin-started 'pihole -up' and automated SSH recovery, so recovery can restart FTL (and, if the API stays down, reboot) mid-update | Fixed | A per-node maintenance lock is shared by update, gravity, backup, recovery and watchdog; a second update is refused while one runs. |
| R2-F8 | Confirmed (Low) | Recovery restart/reboot budget and the 'manual intervention required' stop are held only in memory, so every app restart re-arms 3 FTL restarts and a 'sudo reboot' (and resets the watchdog cooldown) | Fixed | The recovery budget and the "manual intervention required" stop are stored in the database and survive restarts; at most one automatic reboot per node per 24 h. |
| R2-NV4 | Lead, checked | Automated recovery restarts FTL three times and then reboots each Pi-hole node based only on app-side HTTP timeouts, with no node-local or DNS-plane check and no cross-node coordination | Fixed | Before any restart or reboot the app checks the node's own API and DNS over SSH; a reboot also needs local DNS down; if every node fails at once, or the app itself stalls, it alerts instead of acting; never two nodes at once. |
| R2-NV5 | Lead, checked | Watchdog turns the CLOSE-WAIT count on a node's :80 (web plane) into a restart of pihole-FTL (DNS plane), with only an in-memory 15-minute cooldown per node and no staggering across nodes | Fixed | The watchdog counts FTL's web ports (80 and 443), restarts only when the API is down on the node itself, and keeps its cooldown and a daily cap in the database. |

## Run 3A: Secrets at rest and in transit, SSRF and other outbound requests

| ID | Verdict | Finding (as recorded) | Status | Fix |
|---|---|---|---|---|
| R3A-F1 | Confirmed (Low) | Changing the backup webhook URL keeps the stored X-Webhook-Token and sends it to the new destination | Fixed | Changing the webhook URL clears the stored token unless a new token is supplied with it. |
| R3A-NV1 | Lead, checked | Backup webhook X-Webhook-Token is forwarded to any cross-origin redirect target | Fixed | Webhook requests never follow redirects. |
| R3A-NV2 | Lead, checked | Viewer-readable nebula status returns raw nebula-sync container logs, unfiltered, from a root SSH session | Fixed | As R2-NV1: raw container logs are returned to admins only. |
| R3A-F2 | Confirmed (Low) | Unbounded email push awaited under the global poll mutex stalls offline detection and auto-recovery for all Pi-hole nodes | Fixed | SMTP connections have timeouts, and sending a notification no longer holds up polling or recovery. |
| R3A-F3 | Confirmed (Low) | Email channel sends SMTP AUTH credentials in cleartext when an on-path party strips STARTTLS | Fixed | SMTP requires TLS before it authenticates. |
| R3A-NV3 | Lead, checked | Pi-hole node password and SID go over plain http to an admin-configured hostname, which may be resolved through a managed Pi-hole | Fixed | Nodes are reached over https, trusted against your own CA only (`PIHOLE_CA_PATH`); IP-literal instance URLs avoid DNS lookups through the nodes themselves. |
| R3A-NV4 | Lead, checked | A Pi-hole node can redirect the app server's Pi-hole fetches to any destination, and viewers can read the response (request forgery from the app's network position) | Fixed | Node requests never follow redirects (any 3xx is an error), and each session is bound to the URL that issued it. |

## Run 3B: Backups and restore, rendering, audit log, nebula-sync parsing

| ID | Verdict | Finding (as recorded) | Status | Fix |
|---|---|---|---|---|
| R3B-NV1 | Lead, checked | Teleporter zip download is served with no cache directives; caching by the reverse proxy is unverified | Fixed | Backup downloads are sent with `Cache-Control: no-store`. |
| R3B-F1 | Confirmed (Low) | Deleting an instance leaves its Teleporter backup zips on disk, outside the UI and retention | Fixed | Deleting an instance also deletes its backup files. |
| R3B-NV2 | Lead, checked | A Teleporter restore that reaches the node but gets a node error or the 60 s timeout leaves no audit row | Fixed | Restores are audited whatever the node answers, including errors and timeouts. |
| — | Rejected | Teleporter restore can permanently reinstate an expired 'temporary' allow/deny entry and desync scheduled blocking state | No change | Not a vulnerability (reproduction or threat model did not hold). |
| R3B-F2 | Confirmed (Low) | Any 2xx Teleporter reply counts as a good backup and rotates valid restore points out of keep-last-N retention | Fixed | Only a valid Teleporter archive counts as a backup, so a bad reply can never rotate good restore points out. |
| R3B-F3 | Confirmed (Low) | A backup whose row insert fails (instance deleted mid-export) leaves an untracked Teleporter zip on disk | Fixed | The backup row is written before the file, and every failure path removes the file. |
| — | Rejected | Nebula drift check compares only item counts, so divergence that keeps counts equal reads as in sync (a monitoring-coverage limit, not a vulnerability) | No change | Not a vulnerability (reproduction or threat model did not hold). |
| R3B-F4 | Confirmed (Low) | Teleporter export reads a node-controlled body of any size into memory and writes it to the shared data volume | Fixed | Node replies, including Teleporter exports, are size-capped. |

## Run 4: Build, deploy and supply chain

| ID | Verdict | Finding (as recorded) | Status | Fix |
|---|---|---|---|---|
| — | Rejected | Checkout .env is baked into the image as /app/.env and reloaded at start (hardening only: no lower-trust actor or affected principal) | Hardened | Hardened anyway: `.env` is excluded from the image build context. |
| — | Rejected | Root container writes the SQLite DB and Teleporter backups with default modes (0644, dirs 0755) into the host ./data bind mount | Hardened | Hardened anyway: the data directory and files are owner-only. |
| R4-NV1 | Lead, checked | No frame-ancestors / X-Frame-Options: a same-site sibling origin can clickjack one-click admin actions (e.g. disable DNS blocking on a node) | Fixed | `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (plus `nosniff` and a same-origin referrer policy). |
| — | Rejected | The better-sqlite3 native addon in the runtime image comes from a mutable GitHub release asset that no digest pins | No change | Not a vulnerability (reproduction or threat model did not hold). |
| R4-NV2 | Lead, checked | deploy.sh pulls over unauthenticated plain HTTP and runs whatever commit it receives as root on the LXC, with no signature or expected-SHA check | Fixed | The deploy script fetches over SSH with a pinned host key and a read-only deploy key, deploys only an expected full commit SHA that fast-forwards from what is live, and re-runs itself from the verified commit; the main branch is protected. |

## Known limits, decided rather than overlooked

- Encrypted fields are not bound to their database row (no AAD): adding it means a new ciphertext format and re-encrypting everything; the encryption key is never rotated.
- A viewer account can read some admin configuration through the API, and error text is not filtered for viewers. Revisit if you give viewers to people you do not trust.
- Traffic between your reverse proxy and other apps, network segmentation and ARP-level attacks on the LAN are outside this app.

## Reporting a vulnerability

Please use GitHub's private reporting (**Security → Report a vulnerability**) rather than a public issue.
