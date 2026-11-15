'use client'

import { useEffect, useState } from 'react'

// Client view of the nebula-sync primary (see lib/nebula/primary.ts). Config
// editors (domains, adlists, clients) write to the primary only; replicas are
// read-only because nebula-sync overwrites them from the primary.

export type PrimaryState = {
  loaded: boolean
  primaryId: string | null
  primaryName: string | null
}

export function usePrimaryNode(): PrimaryState {
  const [state, setState] = useState<PrimaryState>({ loaded: false, primaryId: null, primaryName: null })
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (cancelled) return
        setState({ loaded: true, primaryId: s?.primaryInstanceId ?? null, primaryName: s?.primaryInstanceName ?? null })
      })
      .catch(() => { if (!cancelled) setState({ loaded: true, primaryId: null, primaryName: null }) })
    return () => { cancelled = true }
  }, [])
  return state
}

/** True when config on this node may be edited: no primary chosen yet, or this IS the primary. */
export function isEditableNode(primaryId: string | null, instanceId: string | undefined): boolean {
  return !primaryId || instanceId === primaryId
}
