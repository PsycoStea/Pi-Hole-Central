'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api, errorText } from '@/lib/client/api'

interface Pin { host: string; alg: string; fp: string; firstSeen: string }

/**
 * Pinned SSH host keys (trust on first use, one per host). Forget is for a
 * legitimate key change, e.g. a reinstalled node: check the new key first.
 */
export default function SshHostKeysPanel({ hostNames }: { hostNames: Record<string, string> }) {
  const [pins, setPins] = useState<Pin[] | null>(null)

  const load = useCallback(async () => {
    try {
      setPins((await api<{ pins: Pin[] }>('/api/ssh/host-keys')).pins)
    } catch {
      setPins([])
    }
  }, [])
  useEffect(() => { load() }, [load])

  const forget = async (p: Pin) => {
    if (!window.confirm(
      `Forget the pinned SSH host key for ${p.host}?\n\n${p.alg} ${p.fp}\n\n` +
      `Only do this if the node was reinstalled and you have checked its new key, e.g.:\n` +
      `ssh-keyscan -t ${p.alg} ${p.host} | ssh-keygen -lf -\n\n` +
      `The next connection will pin whatever key the host presents.`
    )) return
    try {
      await api('/api/ssh/host-keys', { method: 'DELETE', json: { host: p.host } })
      toast.success(`Forgot the host key for ${p.host}; it re-pins on the next connection`)
    } catch (e) {
      toast.error(errorText(e, 'Forget failed'))
    }
    load()
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">SSH host keys</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        The first key each host presents is pinned; a host presenting a different key is refused and raises an
        &ldquo;SSH host key changed&rdquo; alert. Check a pin with{' '}
        <code className="text-[11px]">ssh-keyscan -t &lt;type&gt; &lt;host&gt; | ssh-keygen -lf -</code>.
      </p>
      {pins === null ? null : pins.length === 0 ? (
        <p className="text-xs text-muted-foreground">No hosts pinned yet: keys are pinned on the first SSH connection.</p>
      ) : (
        <div className="surface overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">Host</th>
                <th className="px-4 py-2 font-medium">Key</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap">Pinned</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {pins.map((p) => (
                <tr key={p.host} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className="font-mono text-xs">{p.host}</span>
                    {hostNames[p.host] && <span className="text-xs text-muted-foreground ml-2">{hostNames[p.host]}</span>}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs break-all">
                    <span className="text-muted-foreground">{p.alg}</span> {p.fp}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">{p.firstSeen.slice(0, 10)}</td>
                  <td className="px-4 py-2 text-right">
                    <Button size="sm" variant="outline" className="h-7 text-xs border-border" onClick={() => forget(p)}
                      aria-label={`Forget host key for ${p.host}`}>
                      Forget
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
