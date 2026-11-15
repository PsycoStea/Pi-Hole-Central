import Link from 'next/link'

export type RankedRow = {
  key: string
  label: string
  /** second line, e.g. the IP under a client name */
  sub?: string
  href?: string
  count: number
}

/** Ranked "top N" list: name, share bar, count. Used for domains and clients. */
export default function RankedList({ rows, mono = false, empty = 'Nothing yet' }: { rows: RankedRow[]; mono?: boolean; empty?: string }) {
  if (!rows.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>
  }
  const max = Math.max(...rows.map((r) => r.count)) || 1
  return (
    <ol className="divide-y divide-border">
      {rows.map((r, i) => (
        <li key={`${r.key}-${i}`} className="flex items-center gap-3 py-2.5">
          <span className="num w-5 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <div className={`min-w-0 truncate text-sm ${mono ? 'font-mono text-[0.8125rem]' : ''}`} title={r.label}>
                {r.href ? (
                  <Link href={r.href} className="rounded-sm transition-colors hover:text-primary">
                    {r.label}
                  </Link>
                ) : (
                  r.label
                )}
                {r.sub && <span className="ml-2 font-mono text-xs text-muted-foreground">{r.sub}</span>}
              </div>
              <span className="num shrink-0 text-xs text-muted-foreground">{r.count.toLocaleString()}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full bg-primary/70" style={{ width: `${(r.count / max) * 100}%` }} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}
