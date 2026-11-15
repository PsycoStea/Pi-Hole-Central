import { toast } from 'sonner'
import { api, errorText } from './api'

/**
 * Fleet-wide actions shared by the Overview buttons and the command palette,
 * so both ask the same confirmation and report failures the same way.
 * Each returns false if the user cancelled the confirmation.
 */

type BulkResult = { name: string; ok: boolean; error?: string; failedLists?: number }

export async function runBulkBlocking(enabled: boolean): Promise<boolean> {
  if (
    !enabled &&
    !window.confirm(
      'Disable ad blocking on ALL Pi-holes? Every device on the network will stop being filtered until you re-enable it.'
    )
  ) {
    return false
  }
  try {
    const { results } = await api<{ results: BulkResult[] }>('/api/pihole/bulk/blocking', {
      method: 'POST',
      json: { enabled },
    })
    const failed = results.filter((r) => !r.ok)
    if (failed.length === 0) toast.success(`Blocking ${enabled ? 'enabled' : 'disabled'} on all instances`)
    else toast.error(`Failed on ${failed.map((r) => `${r.name}${r.error ? ` (${r.error})` : ''}`).join(', ')}`, { duration: 12000 })
  } catch (err) {
    toast.error(errorText(err, 'Bulk blocking request failed'))
  }
  return true
}

export async function runBulkGravity(): Promise<boolean> {
  if (!window.confirm('Update gravity on all Pi-holes? They run one at a time and this can take several minutes.')) {
    return false
  }
  const t = toast.loading('Updating gravity on all instances, one at a time…')
  try {
    const { results } = await api<{ results: BulkResult[] }>('/api/pihole/bulk/gravity', { method: 'POST' })
    const failed = results.filter((r) => !r.ok)
    const partial = results.filter((r) => r.ok && r.failedLists)
    if (failed.length > 0) {
      toast.error(`Gravity failed on ${failed.map((r) => `${r.name} (${r.error ?? 'error'})`).join(', ')}`, { id: t, duration: 12000 })
    } else if (partial.length > 0) {
      toast.warning(
        `Gravity updated, but list downloads failed on ${partial.map((r) => `${r.name} (${r.failedLists})`).join(', ')}; cached copies used`,
        { id: t, duration: 12000 }
      )
    } else {
      toast.success('Gravity updated on all instances', { id: t })
    }
  } catch (err) {
    toast.error(errorText(err, 'Bulk gravity request failed'), { id: t })
  }
  return true
}
