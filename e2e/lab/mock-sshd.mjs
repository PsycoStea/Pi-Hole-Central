// Lab SSH server for host-key pinning and Unbound-check tests. Accepts any
// password, runs no commands: every exec returns exit 0 with empty output,
// except the Unbound check (checkUnbound in src/lib/ssh/unbound.ts), which
// answers as the simulated Unbound state says.
// Usage: node e2e/lab/mock-sshd.mjs <sshPort> <controlPort>
// Control (HTTP on 127.0.0.1:<controlPort>):
//   GET  /__fingerprint -> { alg, fp } of the current host key (OpenSSH format)
//   POST /__rotate      -> new host key, same port (simulates a reinstall / impostor)
//   POST /__unbound     -> body {"state":"running"|"stopped"|"hung"}; GET returns it
import http from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Server, utils } = require('ssh2')

const sshPort = Number(process.argv[2] ?? 18022)
const controlPort = Number(process.argv[3] ?? 18023)

let server = null
let current = null
let unboundState = 'running'

const UNBOUND_CHECK_MARK = '__PC_UNBOUND_STOPPED__'
function unboundCheckOutput() {
  if (unboundState === 'stopped') return `${UNBOUND_CHECK_MARK} inactive\n`
  if (unboundState === 'hung') return ';; communications error to 127.0.0.1#5335: timed out\n'
  return [
    ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1',
    'localhost.\t\t10800\tIN\tA\t127.0.0.1',
    ';; Query time: 0 msec',
    '',
  ].join('\n')
}

function newKey() {
  const { private: priv } = utils.generateKeyPairSync('ed25519')
  const blob = utils.parseKey(priv).getPublicSSH()
  const alg = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('ascii')
  const fp = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return { priv, alg, fp }
}

function start() {
  current = newKey()
  server = new Server({ hostKeys: [current.priv] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' ? ctx.accept() : ctx.reject(['password'])))
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          if (info.command.includes(UNBOUND_CHECK_MARK)) stream.write(unboundCheckOutput())
          stream.exit(0)
          stream.end()
        })
      })
    })
    client.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(sshPort, '127.0.0.1', resolve))
}

await start()
console.log(`mock sshd on ${sshPort} (${current.alg} ${current.fp}), control on ${controlPort}`)

http.createServer(async (req, res) => {
  if (req.url === '/__fingerprint') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ alg: current.alg, fp: current.fp }))
  }
  if (req.url === '/__rotate' && req.method === 'POST') {
    await new Promise((r) => server.close(r))
    await start()
    console.log(`rotated host key -> ${current.fp}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ alg: current.alg, fp: current.fp }))
  }
  if (req.url === '/__unbound') {
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const state = JSON.parse(body || '{}').state
      if (!['running', 'stopped', 'hung'].includes(state)) {
        res.writeHead(400); return res.end('state must be running|stopped|hung')
      }
      unboundState = state
      console.log(`unbound -> ${state}`)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ state: unboundState }))
  }
  res.writeHead(404); res.end()
}).listen(controlPort, '127.0.0.1')
