'use client'

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { format } from 'date-fns'

interface HistoryRow {
  instanceId: string
  timestamp: string
  blockPct: number
  status: string
}

interface BlockRateChartProps {
  data: HistoryRow[]
  instanceNames: Record<string, string>
}

const COLORS = ['#60a5fa', '#34d399', '#f472b6', '#a78bfa', '#fb923c']

export default function BlockRateChart({ data, instanceNames }: BlockRateChartProps) {
  const instanceIds = [...new Set(data.map((d) => d.instanceId))]

  // Group by timestamp, pivot by instance
  const byTime = new Map<string, Record<string, number>>()
  for (const row of data) {
    if (row.status !== 'online') continue
    const ts = new Date(row.timestamp).toISOString()
    if (!byTime.has(ts)) byTime.set(ts, { ts: new Date(row.timestamp).getTime() })
    byTime.get(ts)![row.instanceId] = row.blockPct
  }

  const chartData = [...byTime.values()]
    .sort((a, b) => (a.ts as number) - (b.ts as number))
    .map((d) => ({ ...d, time: d.ts as number }))

  if (!chartData.length) {
    return (
      <div className="glass-card p-6 flex items-center justify-center h-48">
        <p className="text-white/30 text-sm">No historical data yet — polling every 5 minutes</p>
      </div>
    )
  }

  return (
    <div className="glass-card p-6">
      <h3 className="text-sm font-medium text-white/70 mb-4">Block Rate Over Time</h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="time"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v) => format(v, 'HH:mm')}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tickFormatter={(v) => `${v.toFixed(0)}%`}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            domain={[0, 'auto']}
          />
          <Tooltip
            contentStyle={{
              background: 'rgba(10,10,20,0.9)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            labelFormatter={(v) => format(v, 'MMM d, HH:mm')}
            formatter={(v, name) => [`${Number(v).toFixed(1)}%`, instanceNames[String(name)] ?? String(name)]}
          />
          <Legend
            formatter={(value) => instanceNames[value] ?? value}
            wrapperStyle={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}
          />
          {instanceIds.map((id, i) => (
            <Line
              key={id}
              type="monotone"
              dataKey={id}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
