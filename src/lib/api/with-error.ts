import { NextResponse } from 'next/server'

/**
 * Wraps a route handler so an uncaught throw returns a JSON error body with a
 * 500 status instead of Next.js's bare, empty-bodied 500. Empty 500 bodies were
 * a recurring bug here: the client's `res.json()` throws "Unexpected end of JSON
 * input" and every node hiccup looks like an app crash.
 *
 * Use for handlers that call Pi-hole / SSH / DB code which can throw. Guards
 * (requireAdmin) inside the handler still work — they return early with their
 * own responses and never reach the catch.
 */
export function withApiError<Ctx = unknown>(
  handler: (req: Request, ctx: Ctx) => Promise<Response> | Response
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx)
    } catch (err) {
      let path = ''
      try {
        path = new URL(req.url).pathname
      } catch {
        /* non-standard url */
      }
      console.error(`[api] ${req.method} ${path} failed:`, err)
      const message = err instanceof Error ? err.message : 'Internal server error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }
}
