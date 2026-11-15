// Minimal in-memory Pi-hole v6 API mock for local pihole-central testing.
// Usage: node e2e/lab/mock-pihole.mjs <port> <name>
// Test hooks: GET /__writes lists every mutating request received; POST /__reset clears state;
// POST /__offline makes every /api call answer 503 until the next /__reset.
// Covers what the dashboard's config editors and summary need: auth, stats summary,
// blocking, groups, domains, lists, clients. Anything else answers 404 JSON.
import http from 'node:http'

const port = Number(process.argv[2] ?? 18081)
const name = process.argv[3] ?? `mock-${port}`

// MOCK_DEMO=1 (e.g. `MOCK_DEMO=1 e2e/lab/start-lab.sh`) fills the read-only
// stats with plausible numbers for design work and screenshots. The e2e suite
// runs without it and sees the empty fixtures above.
const DEMO = process.env.MOCK_DEMO === '1' ? (() => {
  const scale = port % 2 ? 1 : 0.62
  const domains = [
    ['connectivitycheck.gstatic.com', 4120], ['api.spotify.com', 2890], ['graph.facebook.com', 2210],
    ['www.googleapis.com', 1985], ['mobile.events.data.microsoft.com', 1720], ['time.apple.com', 1310],
    ['clients4.google.com', 1150], ['ssl.google-analytics.com', 980], ['app-measurement.com', 845],
    ['dns.msftncsi.com', 610],
  ].map(([domain, count]) => ({ domain, count: Math.round(count * scale) }))
  const clients = [
    ['192.168.1.24', 'michaels-macbook', 6210], ['192.168.1.31', 'living-room-tv', 4380], ['192.168.1.12', 'pixel-8', 3120],
    ['192.168.1.40', 'home-assistant', 2240], ['192.168.1.55', '', 1410], ['192.168.1.18', 'ipad-air', 980],
  ].map(([ip, name, count]) => ({ ip, name, count: Math.round(count * scale) }))
  const total = Math.round(28640 * scale)
  const blocked = Math.round(total * 0.137)
  return {
    domains, clients,
    summary: { total, blocked, percent_blocked: (blocked / total) * 100, unique_domains: 2140, forwarded: Math.round(total * 0.6), cached: Math.round(total * 0.25) },
    history() {
      const now = Math.floor(Date.now() / 600_000) * 600
      return Array.from({ length: 144 }, (_, k) => {
        const t = now - (143 - k) * 600
        const hour = new Date(t * 1000).getHours()
        const day = hour >= 7 && hour <= 23 ? 1 : 0.25
        const tot = Math.round((120 + 180 * day + 60 * Math.sin(k / 9)) * scale)
        return { timestamp: t, total: tot, blocked: Math.round(tot * (0.1 + 0.06 * Math.sin(k / 13))), cached: 0, forwarded: 0 }
      })
    },
  }
})() : null

let state, writes, offline
function reset() {
  offline = false
  state = {
    domains: { allow: [], deny: [] },
    lists: [{ id: 1, address: `https://example.com/${name}-base.txt`, comment: 'base', enabled: true, groups: [0], type: 'block' }],
    clients: [],
    groups: [{ id: 0, name: 'Default', description: '', enabled: true }, { id: 1, name: 'Kids', description: '', enabled: true }],
  }
  writes = []
}
reset()
let nextId = 100

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

let mm0
http.createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const body = raw ? (() => { try { return JSON.parse(raw) } catch { return {} } })() : {}
  const u = new URL(req.url, 'http://x')
  const p = decodeURIComponent(u.pathname)
  const m = req.method

  if (p === '/__writes') return send(res, 200, writes)
  if (p === '/__reset') { reset(); return send(res, 200, { ok: true }) }
  if (p === '/__offline') { offline = true; return send(res, 200, { ok: true }) }
  if (offline) { res.destroy(); return }
  if (m !== 'GET' && p !== '/api/auth') writes.push({ method: m, path: p, body })

  if (p === '/api/auth') return m === 'DELETE' ? send(res, 204) : send(res, 200, { session: { valid: true, sid: `sid-${port}`, validity: 1800 } })
  if (req.headers['x-ftl-sid'] !== `sid-${port}`) return send(res, 401, { error: { key: 'unauthorized' } })

  if (p === '/api/stats/summary') return send(res, 200, {
    queries: DEMO ? DEMO.summary : { total: 1000, blocked: 100, percent_blocked: 10, unique_domains: 50, forwarded: 800, cached: 100 },
    clients: { active: 3, total: 5 },
    gravity: { domains_being_blocked: 12345, last_update: Math.floor(Date.now() / 1000) },
  })
  if (p === '/api/dns/blocking') return send(res, 200, { blocking: 'enabled', timer: null })
  if (p.startsWith('/api/stats/top_domains')) return send(res, 200, { domains: DEMO ? DEMO.domains : [] })
  if (p.startsWith('/api/stats/top_clients')) return send(res, 200, { clients: DEMO ? DEMO.clients : [] })
  if (p.startsWith('/api/history')) return send(res, 200, { history: DEMO ? DEMO.history() : [] })
  if (p === '/api/groups') return send(res, 200, { groups: state.groups })
  if ((mm0 = p.match(/^\/api\/groups\/(.+)$/)) && m === 'PUT') {
    const g = state.groups.find((x) => x.name === mm0[1])
    if (!g) return send(res, 404, { error: { key: 'not_found' } })
    Object.assign(g, { enabled: body.enabled ?? g.enabled, comment: body.comment ?? g.comment })
    return send(res, 200, { groups: [g], processed: { success: [{ item: g.name }], errors: [] } })
  }

  let mm
  if ((mm = p.match(/^\/api\/domains\/(allow|deny)(?:\/(exact|regex))?(?:\/(.+))?$/))) {
    const [, list, kind, dom] = mm
    if (m === 'GET') return send(res, 200, { domains: state.domains[list].filter((d) => !kind || d.kind === kind) })
    if (m === 'POST') {
      const d = { id: nextId++, domain: body.domain, kind, comment: body.comment ?? '', enabled: body.enabled ?? true, groups: body.groups ?? [0], type: list }
      state.domains[list].push(d)
      return send(res, 201, { domains: [d], processed: { success: [{ item: body.domain }], errors: [] } })
    }
    if (m === 'DELETE') {
      state.domains[list] = state.domains[list].filter((d) => !(d.domain === dom && d.kind === kind))
      return send(res, 204)
    }
  }
  if ((mm = p.match(/^\/api\/lists(?:\/(.+))?$/))) {
    const addr = mm[1]
    if (m === 'GET') return send(res, 200, { lists: state.lists })
    if (m === 'POST') {
      const l = { id: nextId++, address: body.address, comment: body.comment ?? '', enabled: body.enabled ?? true, groups: body.groups ?? [0], type: 'block' }
      state.lists.push(l)
      return send(res, 201, { lists: [l], processed: { success: [{ item: body.address }], errors: [] } })
    }
    if (m === 'PUT') {
      const l = state.lists.find((x) => x.address === addr)
      if (!l) return send(res, 404, { error: { key: 'not_found' } })
      Object.assign(l, { comment: body.comment ?? l.comment, enabled: body.enabled ?? l.enabled, groups: body.groups ?? l.groups })
      return send(res, 200, { lists: [l], processed: { success: [{ item: addr }], errors: [] } })
    }
    if (m === 'DELETE') { state.lists = state.lists.filter((x) => x.address !== addr); return send(res, 204) }
  }
  if ((mm = p.match(/^\/api\/clients(?:\/(.+))?$/))) {
    const cl = mm[1]
    if (m === 'GET') return send(res, 200, { clients: state.clients })
    if (m === 'POST') {
      const c = { id: nextId++, client: body.client, comment: body.comment ?? '', groups: body.groups ?? [0], name: null }
      state.clients.push(c)
      return send(res, 201, { clients: [c], processed: { success: [{ item: body.client }], errors: [] } })
    }
    if (m === 'PUT') {
      const c = state.clients.find((x) => x.client === cl)
      if (!c) return send(res, 404, { error: { key: 'not_found' } })
      Object.assign(c, { comment: body.comment ?? c.comment, groups: body.groups ?? c.groups })
      return send(res, 200, { clients: [c], processed: { success: [{ item: cl }], errors: [] } })
    }
    if (m === 'DELETE') { state.clients = state.clients.filter((x) => x.client !== cl); return send(res, 204) }
  }
  if (p === '/api/action/gravity' && m === 'POST') {
    // Streamed like the real `pihole -g` output; the client waits for the end of
    // the body and requires "Swapping databases" to count the run as complete.
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    const lines = ['  [i] Neutrino emissions detected...', '  [✓] Pulling blocklist source list into range',
      '  [i] Target: https://example.com/list.txt', '  [✓] Status: Retrieval successful',
      '  [✓] Building tree', '  [✓] Swapping databases', '  [✓] Done.']
    let i = 0
    const t = setInterval(() => {
      if (i < lines.length) res.write(lines[i++] + '\n')
      else { clearInterval(t); res.end() }
    }, 250)
    return
  }
  if (p.startsWith('/api/info')) return send(res, 200, {})
  return send(res, 404, { error: { key: 'not_found', message: `mock has no ${m} ${p}` } })
}).listen(port, '127.0.0.1', () => console.log(`${name} listening on ${port}`))
