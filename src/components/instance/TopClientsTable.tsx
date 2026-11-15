import RankedList from './RankedList'

interface TopClient {
  ip: string
  name: string
  count: number
}

export default function TopClientsTable({ clients, instanceId }: { clients: TopClient[]; instanceId?: string }) {
  return (
    <RankedList
      empty="No clients recorded yet"
      rows={clients.map((c) => ({
        key: c.ip,
        label: c.name || c.ip,
        sub: c.name && c.name !== c.ip ? c.ip : undefined,
        href: instanceId ? `/queries?instance=${instanceId}&client=${c.ip}` : undefined,
        count: c.count,
      }))}
    />
  )
}
