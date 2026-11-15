import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

const ALGO = 'aes-256-gcm'

const DEV_FALLBACK_KEY = 'dev-key-change-me-in-production'

function resolveKeyMaterial(): string {
  const provided = process.env.ENCRYPTION_KEY

  // In production, refuse ONLY insecure configurations: a missing/empty key, or
  // the publicly-known dev constant. We deliberately do NOT reject on key length
  // — an operator's existing key already encrypts stored passwords, and refusing
  // it (or forcing a change) would make all AES-GCM ciphertext undecryptable.
  // Skip during `next build`, which imports modules under NODE_ENV=production
  // without the runtime env present.
  const isProdRuntime =
    process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build'
  if (isProdRuntime && (!provided || provided === DEV_FALLBACK_KEY)) {
    throw new Error(
      'ENCRYPTION_KEY is missing/empty or set to the insecure default. ' +
        'Set a strong, unique ENCRYPTION_KEY in the environment before starting in production.'
    )
  }

  return provided && provided.length > 0 ? provided : DEV_FALLBACK_KEY
}

// Derive the key lazily on first use so the boot check runs at runtime (when a
// password is actually encrypted/decrypted), not at module import / build time.
let cachedKey: Buffer | null = null
function getKey(): Buffer {
  if (!cachedKey) cachedKey = scryptSync(resolveKeyMaterial(), 'pihole-central-salt', 32)
  return cachedKey
}

export function encrypt(text: string): string {
  const key = getKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':')
}

// Exactly what encrypt() writes: 12-byte IV, 16-byte tag, ciphertext (may be
// empty for an empty plaintext), all lowercase hex, colon-separated.
const STORED_FORMAT = /^([0-9a-f]{24}):([0-9a-f]{32}):((?:[0-9a-f]{2})*)$/

export function decrypt(data: string): string {
  const key = getKey()
  // Strict parse + fixed tag length (audit run-2/run-3a): GCM otherwise
  // accepts tags truncated to 12, 8 or 4 bytes, and Buffer.from(hex) silently
  // drops odd trailing digits and ignores extra ':' parts.
  const m = STORED_FORMAT.exec(data)
  if (!m) throw new Error('Encrypted value is not in iv:tag:ciphertext form')
  const [, ivHex, tagHex, encHex] = m
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'), { authTagLength: 16 })
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]).toString('utf8')
}
