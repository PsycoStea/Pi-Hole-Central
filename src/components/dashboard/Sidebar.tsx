'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import {
  LayoutDashboard,
  Server,
  Settings,
  Bell,
  LogOut,
  ShieldCheck,
  ChevronRight,
  SlidersHorizontal,
  ScrollText,
  FilterX,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const navItems = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/queries', label: 'Query Log', icon: ScrollText },
  { href: '/settings/domains', label: 'Domains', icon: FilterX },
  { href: '/settings/general', label: 'General', icon: SlidersHorizontal },
  { href: '/settings/instances', label: 'Instances', icon: Server },
  { href: '/settings/notifications', label: 'Notifications', icon: Bell },
  { href: '/settings/alerts', label: 'Alerts', icon: Settings },
]

export default function Sidebar({ user }: { user: string }) {
  const pathname = usePathname()

  return (
    <aside className="w-64 h-full glass border-r border-white/10 flex flex-col shrink-0">
      {/* Logo */}
      <div className="p-6 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <ShieldCheck className="h-5 w-5 text-blue-400" />
          </div>
          <div>
            <p className="font-semibold text-sm">Pi-Hole Central</p>
            <p className="text-xs text-white/40">Dashboard</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active =
            href === '/' ? pathname === '/' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all group',
                active
                  ? 'bg-blue-500/15 text-blue-300 border border-blue-500/20'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {active && <ChevronRight className="h-3 w-3 opacity-50" />}
            </Link>
          )
        })}
      </nav>

      {/* User + logout */}
      <div className="p-4 border-t border-white/10">
        <div className="flex items-center gap-3 mb-3 px-2">
          <div className="h-7 w-7 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-xs font-bold uppercase">
            {user[0]}
          </div>
          <span className="text-sm text-white/70 flex-1 truncate">{user}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-white/50 hover:text-white hover:bg-white/5 gap-2"
          onClick={() => signOut({ callbackUrl: '/login' })}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </aside>
  )
}
