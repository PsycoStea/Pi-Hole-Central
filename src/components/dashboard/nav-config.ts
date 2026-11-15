import {
  LayoutDashboard,
  Server,
  Settings,
  Bell,
  ShieldCheck,
  SlidersHorizontal,
  ScrollText,
  FilterX,
  List,
  UserCog,
  Users2,
  ListFilter,
  Clock,
  MonitorSmartphone,
  DatabaseBackup,
  GitCompareArrows,
  BellRing,
  History,
  type LucideIcon,
} from 'lucide-react'

export type NavLink = {
  href: string
  label: string
  icon: LucideIcon
  /** custom active matcher (defaults to startsWith / exact for '/') */
  match?: (pathname: string) => boolean
}

export type NavGroup = {
  id: string
  label: string
  icon: LucideIcon
  children: NavLink[]
}

export type NavEntry = NavLink | NavGroup

export const isGroup = (e: NavEntry): e is NavGroup => 'children' in e

// Admin information architecture: 4 primary links + 2 collapsible groups
export const adminNav: NavEntry[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/queries', label: 'Query Log', icon: ScrollText },
  {
    href: '/settings/instances',
    label: 'Instances',
    icon: Server,
    // also highlight on the per-instance detail/manage pages
    match: (p) => p.startsWith('/settings/instances') || p.startsWith('/instances'),
  },
  { href: '/settings/sync', label: 'Sync', icon: GitCompareArrows },
  {
    id: 'filtering',
    label: 'Filtering',
    icon: ListFilter,
    children: [
      { href: '/settings/domains', label: 'Domains', icon: FilterX },
      { href: '/settings/adlists', label: 'Adlists', icon: List },
      { href: '/settings/clients', label: 'Clients', icon: MonitorSmartphone },
      { href: '/settings/schedules', label: 'Schedules', icon: Clock },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    children: [
      { href: '/settings/general', label: 'General', icon: SlidersHorizontal },
      { href: '/settings/backups', label: 'Backups', icon: DatabaseBackup },
      { href: '/settings/notifications', label: 'Notifications', icon: Bell },
      { href: '/settings/alerts', label: 'Alerts', icon: BellRing },
      { href: '/settings/watchdog', label: 'Watchdog', icon: ShieldCheck },
      { href: '/settings/users', label: 'Users', icon: Users2 },
      { href: '/settings/audit', label: 'Audit Log', icon: History },
      { href: '/settings/account', label: 'Account', icon: UserCog },
    ],
  },
]

export const viewerNav: NavEntry[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/queries', label: 'Query Log', icon: ScrollText },
  { href: '/settings/account', label: 'Account', icon: UserCog },
]

export function linkActive(link: NavLink, pathname: string): boolean {
  if (link.match) return link.match(pathname)
  if (link.href === '/') return pathname === '/'
  return pathname === link.href || pathname.startsWith(link.href + '/')
}
