'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { Command } from 'cmdk'
import { runBulkBlocking, runBulkGravity } from '@/lib/client/bulk-actions'
import {
  LayoutDashboard,
  ScrollText,
  Server,
  FilterX,
  List,
  SlidersHorizontal,
  Bell,
  Settings,
  ShieldCheck,
  Users2,
  UserCog,
  Clock,
  MonitorSmartphone,
  DatabaseBackup,
  GitCompareArrows,
  Search,
  Sun,
  Moon,
  ShieldX,
  RefreshCw,
  CornerDownLeft,
  type LucideIcon,
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { OPEN_COMMAND_PALETTE } from '@/components/dashboard/command-palette-events'

type Role = 'admin' | 'viewer'

type Route = { href: string; label: string; icon: LucideIcon; keywords?: string }

const adminRoutes: Route[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, keywords: 'dashboard home' },
  { href: '/queries', label: 'Query Log', icon: ScrollText, keywords: 'dns queries logs' },
  { href: '/notifications', label: 'Notification Centre', icon: Bell, keywords: 'alerts notifications unread bell feed' },
  { href: '/settings/instances', label: 'Instances', icon: Server, keywords: 'pihole nodes' },
  { href: '/settings/sync', label: 'Sync Status', icon: GitCompareArrows, keywords: 'nebula sync drift config consistency' },
  { href: '/settings/domains', label: 'Domains', icon: FilterX, keywords: 'allow deny block filter regex temporary' },
  { href: '/settings/adlists', label: 'Adlists', icon: List, keywords: 'gravity blocklists' },
  { href: '/settings/clients', label: 'Clients', icon: MonitorSmartphone, keywords: 'devices groups per-client assignment' },
  { href: '/settings/schedules', label: 'Schedules', icon: Clock, keywords: 'blocking profiles time bedtime focus recurring' },
  { href: '/settings/general', label: 'General', icon: SlidersHorizontal, keywords: 'config settings' },
  { href: '/settings/backups', label: 'Backups', icon: DatabaseBackup, keywords: 'teleporter export restore n8n schedule' },
  { href: '/settings/notifications', label: 'Notifications', icon: Bell, keywords: 'channels email' },
  { href: '/settings/alerts', label: 'Alerts', icon: Settings, keywords: 'rules' },
  { href: '/settings/watchdog', label: 'Watchdog', icon: ShieldCheck, keywords: 'monitor recovery' },
  { href: '/settings/users', label: 'Users', icon: Users2, keywords: 'accounts roles' },
  { href: '/settings/audit', label: 'Audit Log', icon: ScrollText, keywords: 'audit history who changed changes log' },
  { href: '/settings/account', label: 'Account', icon: UserCog, keywords: 'profile password' },
]

const viewerRoutes: Route[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, keywords: 'dashboard home' },
  { href: '/queries', label: 'Query Log', icon: ScrollText, keywords: 'dns queries logs' },
]

interface InstanceLite {
  id: string
  name: string
  url: string
}

export default function CommandPalette({ role }: { role: Role }) {
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [instances, setInstances] = useState<InstanceLite[]>([])

  const routes = role === 'admin' ? adminRoutes : viewerRoutes

  // global open: ⌘K / Ctrl+K toggle + custom event from the sidebar search button
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_COMMAND_PALETTE, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_COMMAND_PALETTE, onOpen)
    }
  }, [])

  // load instances when the palette first opens
  useEffect(() => {
    if (!open || instances.length > 0) return
    fetch('/api/instances')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        const list = Array.isArray(data) ? data : (data.instances ?? [])
        setInstances(list.map((i: InstanceLite) => ({ id: i.id, name: i.name, url: i.url })))
      })
      .catch(() => {})
  }, [open, instances.length])

  const run = useCallback((fn: () => void) => {
    setOpen(false)
    // let the dialog close before navigating/acting
    setTimeout(fn, 0)
  }, [])

  const bulkBlocking = useCallback((enabled: boolean) => runBulkBlocking(enabled), [])
  const bulkGravity = useCallback(() => runBulkGravity(), [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="max-w-xl p-0 gap-0 top-[12vh] translate-y-0 overflow-hidden ring-1 ring-foreground/10"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search and jump to pages, instances, and actions.
        </DialogDescription>

        <Command
          loop
          className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <Command.Input
              autoFocus
              placeholder="Search pages, instances, actions…"
              className="flex h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border shrink-0">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-[60vh] overflow-y-auto p-1.5">
            <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
              No results found.
            </Command.Empty>

            <Command.Group heading="Navigate">
              {routes.map((r) => (
                <Item
                  key={r.href}
                  value={`nav ${r.label} ${r.keywords ?? ''}`}
                  onSelect={() => run(() => router.push(r.href))}
                >
                  <r.icon className="h-4 w-4 text-muted-foreground" />
                  <span>{r.label}</span>
                </Item>
              ))}
            </Command.Group>

            {instances.length > 0 && (
              <Command.Group heading="Instances">
                {instances.map((inst) => (
                  <Item
                    key={inst.id}
                    value={`instance ${inst.name} ${inst.url}`}
                    onSelect={() => run(() => router.push(`/instances/${inst.id}`))}
                  >
                    <Server className="h-4 w-4 text-muted-foreground" />
                    <span>{inst.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground font-mono">{inst.url}</span>
                  </Item>
                ))}
              </Command.Group>
            )}

            <Command.Group heading="Actions">
              <Item
                value="action toggle theme dark light mode appearance"
                onSelect={() => run(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}
              >
                {theme === 'dark' ? (
                  <Sun className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Moon className="h-4 w-4 text-muted-foreground" />
                )}
                <span>Toggle theme ({theme === 'dark' ? 'light' : 'dark'})</span>
              </Item>

              {role === 'admin' && (
                <>
                  <Item
                    value="action enable all blocking on"
                    onSelect={() => run(() => bulkBlocking(true))}
                  >
                    <ShieldCheck className="h-4 w-4 text-success" />
                    <span>Enable blocking on all instances</span>
                  </Item>
                  <Item
                    value="action disable all blocking off"
                    onSelect={() => run(() => bulkBlocking(false))}
                  >
                    <ShieldX className="h-4 w-4 text-destructive" />
                    <span>Disable blocking on all instances</span>
                  </Item>
                  <Item
                    value="action update gravity refresh blocklists"
                    onSelect={() => run(() => bulkGravity())}
                  >
                    <RefreshCw className="h-4 w-4 text-primary" />
                    <span>Update gravity on all instances</span>
                  </Item>
                </>
              )}
            </Command.Group>
          </Command.List>

          <div className="flex items-center justify-end gap-3 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" /> to select
            </span>
            <span>↑↓ to navigate</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function Item({
  value,
  onSelect,
  children,
}: {
  value: string
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-foreground/90 cursor-pointer select-none data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
    >
      {children}
    </Command.Item>
  )
}
