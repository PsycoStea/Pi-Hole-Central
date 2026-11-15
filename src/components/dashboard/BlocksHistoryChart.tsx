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
import { BarChart3 } from 'lucide-react'

interface DataPoint {
  timestamp: number
  blocked: number
  total: number
}

interface Props {
  data: DataPoint[]
  /** Card title, e.g. "Queries — last 24 hours". */
  label?: string
}

function formatTick(ts: number): string {
  return format(new Date(ts * 1000), 'HH:mm')
}

function formatTooltipTime(ts: number): string {
  return format(new Date(ts * 1000), 'MMM d, HH:mm')
}

const TOTAL = 'var(--chart-1)'
const BLOCKED = 'var(--destructive)'

function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: TOTAL }} />
        Total
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: BLOCKED }} />
        Blocked
      </span>
    </div>
  )
}

export default function BlocksHistoryChart({ data, label }: Props) {
  return (
    <section className="surface flex h-full flex-col p-4 sm:p-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {label && <h2 className="text-sm font-semibold">{label}</h2>}
        {data.length > 0 && <Legend />}
      </header>
      {data.length === 0 ? (
        <div className="flex h-[240px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <BarChart3 className="h-6 w-6 text-muted-foreground/60" aria-hidden />
          <p>No history yet. It fills in as the poller collects data.</p>
        </div>
      ) : (
        <div className="h-[240px]">
          <ResponsiveContainer width="100%" height={240} initialDimension={{ width: 600, height: 240 }}>
            <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="totalGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={TOTAL} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={TOTAL} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="blockedGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={BLOCKED} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={BLOCKED} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="timestamp"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                tickFormatter={formatTick}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={44}
                allowDecimals={false}
                tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v))}
              />
              <Tooltip
                cursor={{ stroke: 'var(--border)' }}
                contentStyle={{
                  backgroundColor: 'var(--popover)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: 'var(--popover-foreground)',
                  boxShadow: 'var(--shadow-card)',
                }}
                labelFormatter={(val) => formatTooltipTime(val as number)}
                formatter={(value, name) => [
                  typeof value === 'number' ? value.toLocaleString() : value,
                  name === 'blocked' ? 'Blocked' : 'Total',
                ]}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke={TOTAL}
                strokeWidth={1.5}
                fill="url(#totalGrad)"
                dot={false}
                activeDot={{ r: 3, fill: TOTAL }}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="blocked"
                stroke={BLOCKED}
                strokeWidth={1.5}
                fill="url(#blockedGrad)"
                dot={false}
                activeDot={{ r: 3, fill: BLOCKED }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  )
}
