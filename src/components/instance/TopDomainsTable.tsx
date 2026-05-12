import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface TopDomain {
  domain: string
  count: number
}

export default function TopDomainsTable({ domains }: { domains: TopDomain[] }) {
  if (!domains.length) {
    return <p className="text-muted-foreground text-sm text-center py-8">No data</p>
  }
  const max = Math.max(...domains.map((d) => d.count))
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          <TableHead className="text-muted-foreground">Domain</TableHead>
          <TableHead className="text-muted-foreground text-right w-24">Blocked</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {domains.map((d) => (
          <TableRow key={d.domain} className="border-border hover:bg-accent">
            <TableCell className="font-mono text-xs">
              <div className="space-y-1">
                <p className="text-foreground/90 truncate max-w-xs">{d.domain}</p>
                <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full bg-red-400/60 rounded-full"
                    style={{ width: `${(d.count / max) * 100}%` }}
                  />
                </div>
              </div>
            </TableCell>
            <TableCell className="text-right text-foreground/60 text-xs">{d.count.toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
