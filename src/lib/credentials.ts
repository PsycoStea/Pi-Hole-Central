/**
 * Input rules for usernames and new passwords (audit run-1 notes, FIX-PLAN P3.5).
 * Applied where a password is SET (create user, admin reset, own change), never
 * at sign-in: an existing password that breaks a newer rule must keep working.
 */

// bcrypt uses only the first 72 bytes; anything after them is silently ignored,
// so a longer password is weaker than it looks. Refuse it instead.
const BCRYPT_MAX_BYTES = 72
const MIN_PASSWORD_CHARS = 8
const MAX_USERNAME_CHARS = 64

/** Returns an error message, or null when `pw` is acceptable as a new password. */
export function newPasswordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_CHARS) {
    return `Password must be at least ${MIN_PASSWORD_CHARS} characters`
  }
  if (Buffer.byteLength(pw, 'utf8') > BCRYPT_MAX_BYTES) {
    return `Password must be at most ${BCRYPT_MAX_BYTES} bytes (bcrypt ignores the rest)`
  }
  return null
}

/** Trimmed username, or null when it is not a usable one. */
export function normalizeUsername(u: unknown): string | null {
  if (typeof u !== 'string') return null
  const name = u.trim()
  if (!name || name.length > MAX_USERNAME_CHARS) return null
  // No control characters: they end up in audit rows and the UI.
  if (/[\u0000-\u001f\u007f]/.test(name)) return null
  return name
}
