'use client'

import Link from 'next/link'
import { AlertTriangle, GitCompareArrows, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PrimaryState } from '@/lib/client/primary'

/**
 * Explains where config edits go on the domains / adlists / clients pages.
 * nebula-sync overwrites the replicas from the primary, so only the primary is
 * editable; this tells the user why, and what to do instead.
 */
export default function ReplicaNotice({
  primary,
  selectedInstance,
  primaryOnline,
  thing,
  onSwitchToPrimary,
}: {
  primary: PrimaryState
  /** an instance id, or '__all__' for the merged view */
  selectedInstance: string
  primaryOnline: boolean
  /** e.g. 'domains', 'adlists', 'clients' */
  thing: string
  onSwitchToPrimary?: () => void
}) {
  if (!primary.loaded || !selectedInstance) return null

  if (!primary.primaryId) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-warning/25 bg-warning/5 p-3 text-xs">
        <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
        <p className="text-muted-foreground">
          <span className="text-warning font-medium">No primary node chosen.</span>{' '}
          nebula-sync overwrites the replicas from the primary, so edits made on a replica are undone at the next
          sync. Choose the primary in{' '}
          <Link href="/settings/sync" className="underline hover:text-foreground">Settings → Sync</Link>{' '}
          to make the replicas read-only here.
        </p>
      </div>
    )
  }

  const name = primary.primaryName ?? 'the primary'
  const viewingReplica = selectedInstance !== '__all__' && selectedInstance !== primary.primaryId

  if (viewingReplica) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs">
        <Lock className="h-4 w-4 text-primary shrink-0" />
        <p className="text-muted-foreground flex-1 min-w-[16rem]">
          <span className="text-primary font-medium">Read-only replica.</span>{' '}
          nebula-sync copies {thing} here from {name} (every 15 min), so changes must be made on {name}.
        </p>
        {onSwitchToPrimary && (
          <Button size="sm" variant="outline" onClick={onSwitchToPrimary} className="h-7 text-xs border-border">
            Edit on {name}
          </Button>
        )}
      </div>
    )
  }

  if (!primaryOnline) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-warning/25 bg-warning/5 p-3 text-xs">
        <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
        <p className="text-muted-foreground">
          <span className="text-warning font-medium">Edits paused: {name} is offline.</span>{' '}
          {thing[0].toUpperCase() + thing.slice(1)} are only changed on the primary node; the replicas are overwritten from it.
        </p>
      </div>
    )
  }

  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground px-1">
      <GitCompareArrows className="h-3.5 w-3.5 shrink-0" />
      Changes are made on {name}; nebula-sync copies them to the other nodes within about 15 minutes.
    </p>
  )
}
