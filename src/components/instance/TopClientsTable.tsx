import Link from 'next/link'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface TopClient {
  ip: string
  name: string
  count: number
}

export default function TopClientsTable({
  clients,
  instanceId,
}: {
  clients: TopClient[]
  instanceId?: string
}) {
  if (!clients.length) {
    return <p className="text-muted-foreground text-sm text-center py-8">No data</p>
  }
  const max = Math.max(...clients.map((c) => c.count))
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          <TableHead className="text-muted-foreground">Client</TableHead>
          <TableHead className="text-muted-foreground text-right w-24">Queries</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {clients.map((c) => (
          <TableRow key={c.ip} className="border-border hover:bg-accent">
            <TableCell className="font-mono text-xs">
              <div className="space-y-1">
                {instanceId ? (
                  <Link
                    href={`/queries?instance=${instanceId}&client=${c.ip}`}
                    className="text-foreground/90 hover:text-blue-400 transition-colors cursor-pointer"
                  >
                    {c.name || c.ip}
                  </Link>
                ) : (
                  <p className="text-foreground/90">{c.name || c.ip}</p>
                )}
                {c.name && c.name !== c.ip && (
                  <p className="text-muted-foreground text-xs">{c.ip}</p>
                )}
                <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full bg-blue-400/60 rounded-full"
                    style={{ width: `${(c.count / max) * 100}%` }}
                  />
                </div>
              </div>
            </TableCell>
            <TableCell className="text-right text-foreground/60 text-xs">{c.count.toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
