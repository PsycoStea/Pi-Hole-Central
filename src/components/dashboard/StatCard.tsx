import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  badge?: string
  icon: LucideIcon
  /** Tints the icon only; the number stays in the foreground colour. */
  tone?: 'primary' | 'success' | 'destructive' | 'muted'
  className?: string
}

const tones = {
  primary: 'text-primary bg-primary/10',
  success: 'text-success bg-success/10',
  destructive: 'text-destructive bg-destructive/10',
  muted: 'text-muted-foreground bg-muted',
}

export default function StatCard({ title, value, subtitle, badge, icon: Icon, tone = 'muted', className }: StatCardProps) {
  return (
    <div className={cn('surface flex flex-col gap-3 p-4 sm:p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-muted-foreground">{title}</p>
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', tones[tone])}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
      <div className="min-w-0">
        <p className="num truncate text-2xl font-semibold tracking-tight sm:text-[1.75rem] sm:leading-9">{value}</p>
        {subtitle && <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>}
        {badge && (
          <span className="mt-1.5 inline-flex items-center rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
            {badge}
          </span>
        )}
      </div>
    </div>
  )
}
