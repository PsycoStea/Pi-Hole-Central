import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The one page header: title, optional one-line description, actions on the
 * right (they wrap under the title on narrow screens), optional back link.
 */
export default function PageHeader({
  title,
  description,
  actions,
  back,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  back?: { href: string; label: string }
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6', className)}>
      <div className="min-w-0">
        {back && (
          <Link
            href={back.href}
            className="mb-2 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {back.label}
          </Link>
        )}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">{actions}</div>}
    </div>
  )
}
