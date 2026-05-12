import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  icon: LucideIcon
  color?: 'blue' | 'green' | 'red' | 'purple'
  className?: string
  delay?: number
}

const colors = {
  blue:   'text-blue-400 bg-gradient-to-br from-blue-500/15 to-blue-600/5 border-blue-500/20',
  green:  'text-green-400 bg-gradient-to-br from-green-500/15 to-green-600/5 border-green-500/20',
  red:    'text-red-400 bg-gradient-to-br from-red-500/15 to-red-600/5 border-red-500/20',
  purple: 'text-purple-400 bg-gradient-to-br from-purple-500/15 to-purple-600/5 border-purple-500/20',
}

const glows = {
  blue:   'hover:glow-blue-sm',
  green:  'hover:glow-green-sm',
  red:    'hover:glow-red-sm',
  purple: 'hover:glow-purple-sm',
}

export default function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color = 'blue',
  className,
  delay,
}: StatCardProps) {
  return (
    <div
      className={cn(
        'glass-card p-5 space-y-3 transition-all duration-200 animate-fade-in-up',
        glows[color],
        className
      )}
      style={delay != null ? { animationDelay: `${delay}ms` } : undefined}
    >
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground font-medium">{title}</p>
        <div className={cn('p-2 rounded-lg border', colors[color])}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div>
        <p className="text-2xl font-bold tracking-tight">{value}</p>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
    </div>
  )
}
