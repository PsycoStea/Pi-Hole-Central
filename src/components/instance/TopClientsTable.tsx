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

export default function TopClientsTable({ clients }: { clients: TopClient[] }) {
  if (!clients.length) {
    return <p className="text-white/30 text-sm text-center py-8">No data</p>
  }
  const max = Math.max(...clients.map((c) => c.count))
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-white/10 hover:bg-transparent">
          <TableHead className="text-white/50">Client</TableHead>
          <TableHead className="text-white/50 text-right w-24">Queries</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {clients.map((c) => (
          <TableRow key={c.ip} className="border-white/5 hover:bg-white/5">
            <TableCell className="font-mono text-xs">
              <div className="space-y-1">
                <p className="text-white/90">{c.name || c.ip}</p>
                {c.name && c.name !== c.ip && (
                  <p className="text-white/30 text-xs">{c.ip}</p>
                )}
                <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full bg-blue-400/60 rounded-full"
                    style={{ width: `${(c.count / max) * 100}%` }}
                  />
                </div>
              </div>
            </TableCell>
            <TableCell className="text-right text-white/60 text-xs">{c.count.toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
