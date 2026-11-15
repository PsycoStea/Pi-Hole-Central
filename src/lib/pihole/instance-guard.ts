import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { instances } from '@/lib/db/schema'
import { NodeBusyError, isAbortError } from './node-load'

/**
 * For per-id read routes that call a node (R2-NV2): the instance must exist
 * and be enabled. A disabled instance is answered 409 with no node call — it
 * used to get a fresh API session and the full query anyway.
 */
export async function enabledInstance(
  id: string
): Promise<{ instance: typeof instances.$inferSelect; denied?: undefined } | { denied: NextResponse }> {
  const instance = await db.query.instances.findFirst({ where: eq(instances.id, id) })
  if (!instance) return { denied: NextResponse.json({ error: 'Instance not found' }, { status: 404 }) }
  if (!instance.enabled) {
    return { denied: NextResponse.json({ error: 'Instance is disabled' }, { status: 409 }) }
  }
  return { instance }
}

/** Error response for a failed node call: 503 when the node's heavy lane is full, else 502. */
export function nodeErrorResponse(err: unknown): NextResponse {
  if (err instanceof NodeBusyError) return NextResponse.json({ error: err.message }, { status: 503 })
  // The client has gone; nobody reads this, so keep it short.
  if (isAbortError(err)) return NextResponse.json({ error: 'Request aborted' }, { status: 499 })
  return NextResponse.json({ error: String(err) }, { status: 502 })
}
