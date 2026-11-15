/**
 * Client-side fetch for this app's own API routes.
 *
 * Throws on any non-2xx status with the server's `error` text, so callers can
 * `try { await api(...); toast.success(...) } catch (e) { toast.error(errorText(e)) }`
 * and never show "saved" for a 400/500. Handles 204 and empty bodies (DELETEs).
 *
 * It does NOT inspect 2xx bodies: partial failures that arrive on a 200
 * (bulk `results[].ok === false`, fan-out `failures[]`) are the caller's job.
 */
export async function api<T = any>(input: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await fetch(input, json === undefined ? rest : {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
    body: JSON.stringify(json),
  })
  const text = await res.text()
  let data: any = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string' && data.error) || `Request failed (HTTP ${res.status})`
    throw new Error(msg)
  }
  return data as T
}

/** The message to show for an error thrown by `api()` (or anything else). */
export function errorText(err: unknown, fallback = 'Request failed'): string {
  return err instanceof Error && err.message ? err.message : fallback
}
