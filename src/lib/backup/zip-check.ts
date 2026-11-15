// Checks that a Teleporter export really is a Pi-hole Teleporter zip before it
// is stored as a backup (R3B-F2: any 2xx body, e.g. a JSON error page, used to
// be saved as a "successful" backup and rotate out the good ones).
//
// Real v6 exports (checked 2026-11-13 on both nodes, ~33 KiB) hold
// etc/pihole/pihole.toml, gravity.db, pihole-FTL.db, hosts, dhcp.leases and
// dnsmasq.d files. pihole.toml is the one entry a restore cannot do without.

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL_DIR = 0x06054b50
const MIN_BYTES = 512
const REQUIRED_ENTRY = 'etc/pihole/pihole.toml'

/** Entry names from the zip's central directory, or an error string. */
export function zipEntryNames(buf: Buffer): string[] | string {
  if (buf.length < 22) return 'too short to be a zip'
  if (buf.readUInt32LE(0) !== LOCAL_HEADER) return 'does not start with a zip header'
  // The end-of-central-directory record sits in the last 22 bytes plus an
  // optional comment of up to 65535 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END_OF_CENTRAL_DIR) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return 'no end-of-central-directory record (truncated?)'
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset + cdSize > eocd) return 'central directory out of bounds'
  const names: string[] = []
  let p = cdOffset
  for (let n = 0; n < total; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL_HEADER) return 'corrupt central directory'
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    if (p + 46 + nameLen > eocd) return 'corrupt central directory'
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/** null when the buffer looks like a usable Teleporter export, else why not. */
export function checkTeleporterZip(buf: Buffer): string | null {
  if (buf.length < MIN_BYTES) return `only ${buf.length} bytes`
  const names = zipEntryNames(buf)
  if (typeof names === 'string') return names
  if (!names.includes(REQUIRED_ENTRY)) return `no ${REQUIRED_ENTRY} in the archive`
  return null
}
