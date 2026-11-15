/**
 * One-line description of an error for logs.
 *
 * Logging the raw error object makes Node's inspector dump every own property:
 * a DOMException TimeoutError (from AbortSignal.timeout) prints its whole legacy
 * code table (ABORT_ERR, TIMEOUT_ERR, ...), and ssh2 errors print their
 * `level: 'client-timeout'` field on a separate line. That buried the actual
 * message in the container logs. Keep it to `Name: message (code)`.
 */
export function errMsg(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const e = err as Error & { code?: unknown; level?: unknown; cause?: unknown }
  const extra: string[] = []
  if (typeof e.code === 'string' || typeof e.code === 'number') extra.push(String(e.code))
  if (typeof e.level === 'string') extra.push(e.level)
  const cause = e.cause as { code?: unknown; message?: unknown } | undefined
  if (cause && typeof cause === 'object') {
    if (typeof cause.code === 'string') extra.push(cause.code)
    else if (typeof cause.message === 'string') extra.push(cause.message)
  }
  const head = e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message
  return extra.length ? `${head} (${extra.join(', ')})` : head
}
