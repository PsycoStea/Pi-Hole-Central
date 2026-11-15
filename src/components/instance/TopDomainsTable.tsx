import RankedList from './RankedList'

interface TopDomain {
  domain: string
  count: number
}

export default function TopDomainsTable({ domains }: { domains: TopDomain[] }) {
  return (
    <RankedList
      mono
      empty="No queries recorded yet"
      rows={domains.map((d) => ({ key: d.domain, label: d.domain, count: d.count }))}
    />
  )
}
