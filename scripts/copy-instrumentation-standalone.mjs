/**
 * Copy the built instrumentation entry (and the chunks it traces) into the
 * `output: 'standalone'` bundle.
 *
 * Why this exists: Next.js 16.2.6 emits `.next/server/instrumentation.js` plus a
 * correct `.nft.json` trace for it, but does NOT copy either the entry or its
 * chunks into `.next/standalone`. Our Dockerfile ships only `.next/standalone`,
 * so in the container `register()` is never invoked — and the loader
 * (server/lib/router-utils/instrumentation-globals.external.js) swallows
 * MODULE_NOT_FOUND silently. The result is a server that starts cleanly, serves
 * pages, and never runs its background poller, with nothing in the logs.
 *
 * That is exactly how this project lost all polling on 2026-08-13: the app had
 * been running an older image, and the first rebuild in weeks silently disabled
 * every alert, health check and backup.
 *
 * Fails loudly (non-zero exit) if the entry is missing, so a future Next.js
 * upgrade that renames or relocates it breaks the build instead of quietly
 * shipping a dead poller again. If a later Next.js version starts including
 * instrumentation in standalone on its own, this script simply copies nothing
 * new and stays harmless.
 */
import fs from 'node:fs'
import path from 'node:path'

const SERVER_DIR = path.resolve('.next/server')
const STANDALONE_DIR = path.resolve('.next/standalone/.next/server')
const ENTRY = 'instrumentation.js'

const entrySrc = path.join(SERVER_DIR, ENTRY)

if (!fs.existsSync(path.resolve('.next/standalone'))) {
  console.log('[instrumentation] no standalone output — nothing to do')
  process.exit(0)
}

if (!fs.existsSync(entrySrc)) {
  console.error(
    `[instrumentation] FATAL: ${entrySrc} not found after build.\n` +
      'The background poller is started from instrumentation.ts, so shipping without it\n' +
      'produces a silently non-functional deployment. Check whether Next.js changed the\n' +
      'instrumentation output path or whether instrumentation.ts moved.'
  )
  process.exit(1)
}

// Traced paths in the .nft.json are relative to the file being traced. Only the
// entries that live under .next/server matter here — anything resolving into
// node_modules is already provided by the Dockerfile's full node_modules copy.
const nftPath = `${entrySrc}.nft.json`
const traced = fs.existsSync(nftPath)
  ? JSON.parse(fs.readFileSync(nftPath, 'utf8')).files ?? []
  : []

let copied = 0
let skipped = 0

for (const rel of [ENTRY, ...traced]) {
  const src = path.resolve(SERVER_DIR, rel)
  if (!src.startsWith(SERVER_DIR + path.sep) && src !== entrySrc) continue
  if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue

  const dest = path.resolve(STANDALONE_DIR, path.relative(SERVER_DIR, src))
  if (fs.existsSync(dest)) {
    skipped++
    continue
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  copied++
}

console.log(
  `[instrumentation] standalone patched: ${copied} file(s) copied, ${skipped} already present`
)

if (!fs.existsSync(path.join(STANDALONE_DIR, ENTRY))) {
  console.error('[instrumentation] FATAL: entry still missing from standalone after copy')
  process.exit(1)
}
