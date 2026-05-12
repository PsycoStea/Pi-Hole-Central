'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { format } from 'date-fns'

interface DataPoint {
  timestamp: number
  blocked: number
  total: number
}

interface Props {
  data: DataPoint[]
  label?: string
}

function formatTick(ts: number): string {
  return format(new Date(ts * 1000), 'HH:mm')
}

function formatTooltipTime(ts: number): string {
  return format(new Date(ts * 1000), 'MMM d, HH:mm')
}

export default function BlocksHistoryChart({ data, label }: Props) {
  if (data.length === 0) {
    return (
      <div className="glass-card p-6">
        {label && (
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-4">{label}</p>
        )}
        <div className="h-[260px] flex items-center justify-center text-muted-foreground text-sm">
          No data — check Pi-Hole connectivity
        </div>
      </div>
    )
  }

  return (
    <div className="glass-card p-6">
      {label && (
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-4">{label}</p>
      )}
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="blockedGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="time"
            tickFormatter={formatTick}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'rgba(0,0,0,0.85)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            labelFormatter={(val) => formatTooltipTime(val as number)}
            formatter={(value, name) => [
              typeof value === 'number' ? value.toLocaleString() : value,
              name === 'blocked' ? 'Blocked' : 'Total',
            ]}
          />
          <Area
            type="monotone"
            dataKey="blocked"
            stroke="#ef4444"
            strokeWidth={2}
            fill="url(#blockedGrad)"
            dot={false}
            activeDot={{ r: 4, fill: '#ef4444' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
