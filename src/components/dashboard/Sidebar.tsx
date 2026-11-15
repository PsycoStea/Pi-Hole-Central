'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { ChevronDown, LogOut, PanelLeftClose, PanelLeftOpen, Search, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/theme-toggle'
import NotificationBell from '@/components/dashboard/NotificationBell'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { openCommandPalette } from '@/components/dashboard/command-palette-events'
import { adminNav, viewerNav, isGroup, linkActive, type NavGroup, type NavLink, type NavEntry } from './nav-config'

export type Role = 'admin' | 'viewer'

export function navFor(role: Role): NavEntry[] {
  return role === 'admin' ? adminNav : viewerNav
}

const iconButton =
  'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground cursor-pointer'

/* ---------- brand ---------- */

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex min-w-0 items-center gap-2.5 rounded-md" aria-label="Pi-hole Central, overview">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <ShieldCheck className="h-4 w-4" aria-hidden />
      </span>
      {!compact && <span className="truncate text-sm font-semibold tracking-tight">Pi-hole Central</span>}
    </Link>
  )
}

/* ---------- search button ---------- */

export function SearchButton({ rail = false }: { rail?: boolean }) {
  if (rail) {
    return (
      <Tooltip>
        <TooltipTrigger render={<button onClick={openCommandPalette} aria-label="Search (⌘K)" className={cn(iconButton, 'h-9 w-full')} />}>
          <Search className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent side="right">Search · ⌘K</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <button
      onClick={openCommandPalette}
      className="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground cursor-pointer"
    >
      <Search className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">⌘K</kbd>
    </button>
  )
}

/* ---------- nav list (shared by the desktop sidebar and the phone drawer) ---------- */

export function NavList({
  nav,
  rail = false,
  onExpandRail,
}: {
  nav: NavEntry[]
  rail?: boolean
  /** rail only: open the sidebar and that group */
  onExpandRail?: (groupId: string) => void
}) {
  const pathname = usePathname()
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  // auto-open the group that contains the active route
  useEffect(() => {
    for (const entry of nav) {
      if (isGroup(entry) && entry.children.some((c) => linkActive(c, pathname))) {
        setOpenGroups((prev) => (prev[entry.id] ? prev : { ...prev, [entry.id]: true }))
      }
    }
  }, [pathname, nav])

  return (
    <ul className="space-y-0.5">
      {nav.map((entry) =>
        isGroup(entry) ? (
          <li key={entry.id}>
            <GroupItem
              group={entry}
              pathname={pathname}
              rail={rail}
              open={!!openGroups[entry.id]}
              onToggle={() => setOpenGroups((p) => ({ ...p, [entry.id]: !p[entry.id] }))}
              onExpandRail={() => {
                setOpenGroups((p) => ({ ...p, [entry.id]: true }))
                onExpandRail?.(entry.id)
              }}
            />
          </li>
        ) : (
          <li key={entry.href}>
            <LinkItem link={entry} active={linkActive(entry, pathname)} rail={rail} />
          </li>
        )
      )}
    </ul>
  )
}

const itemBase =
  'group relative flex items-center rounded-md text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
const itemIdle = 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'
const itemActive = 'bg-sidebar-accent font-medium text-foreground'

function LinkItem({ link, active, rail }: { link: NavLink; active: boolean; rail: boolean }) {
  const { href, label, icon: Icon } = link
  const content = (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      aria-label={rail ? label : undefined}
      className={cn(itemBase, rail ? 'h-9 justify-center' : 'h-9 gap-2.5 px-2.5', active ? itemActive : itemIdle)}
    >
      <Icon className={cn('h-4 w-4 shrink-0', active && 'text-primary')} />
      {!rail && <span className="flex-1 truncate">{label}</span>}
    </Link>
  )
  if (!rail) return content
  return (
    <Tooltip>
      <TooltipTrigger render={content as React.ReactElement} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function GroupItem({
  group,
  pathname,
  rail,
  open,
  onToggle,
  onExpandRail,
}: {
  group: NavGroup
  pathname: string
  rail: boolean
  open: boolean
  onToggle: () => void
  onExpandRail: () => void
}) {
  const { label, icon: Icon, children } = group
  const hasActiveChild = children.some((c) => linkActive(c, pathname))

  if (rail) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              onClick={onExpandRail}
              aria-label={label}
              className={cn(itemBase, 'h-9 w-full justify-center cursor-pointer', hasActiveChild ? itemActive : itemIdle)}
            />
          }
        >
          <Icon className={cn('h-4 w-4', hasActiveChild && 'text-primary')} />
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={cn(itemBase, 'h-9 w-full gap-2.5 px-2.5 cursor-pointer', itemIdle, hasActiveChild && !open && 'text-foreground')}
      >
        <Icon className={cn('h-4 w-4 shrink-0', hasActiveChild && !open && 'text-primary')} />
        <span className="flex-1 truncate text-left">{label}</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 transition-transform duration-[var(--dur-small)] ease-[var(--ease-out)] motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>
      {/* children: animated height via the grid-rows trick */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-[var(--dur-menu)] ease-[var(--ease-out)] motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
        inert={!open}
      >
        <div className="overflow-hidden">
          <ul className="ml-[1.0625rem] mt-0.5 space-y-0.5 border-l border-sidebar-border pl-2">
            {children.map((child) => {
              const active = linkActive(child, pathname)
              return (
                <li key={child.href}>
                  <Link
                    href={child.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(itemBase, 'h-8 gap-2.5 px-2.5', active ? itemActive : itemIdle)}
                  >
                    <span className="flex-1 truncate">{child.label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </>
  )
}

/* ---------- user footer ---------- */

export function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold uppercase text-primary"
    >
      {name[0]}
    </span>
  )
}

export function UserFooter({
  user,
  role,
  rail = false,
  showBell,
}: {
  user: string
  role: Role
  rail?: boolean
  showBell: boolean
}) {
  const signOutBtn = (
    <button onClick={() => signOut({ callbackUrl: '/login' })} aria-label="Sign out" className={iconButton}>
      <LogOut className="h-4 w-4" />
    </button>
  )
  if (rail) {
    return (
      <div className="flex flex-col items-center gap-1">
        {showBell && role === 'admin' && <NotificationBell rail />}
        <ThemeToggle />
        <Tooltip>
          <TooltipTrigger render={signOutBtn} />
          <TooltipContent side="right">Sign out</TooltipContent>
        </Tooltip>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Avatar name={user} />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-medium">{user}</p>
        <p className="text-xs capitalize text-muted-foreground">{role}</p>
      </div>
      {showBell && role === 'admin' && <NotificationBell />}
      <ThemeToggle />
      <Tooltip>
        <TooltipTrigger render={signOutBtn} />
        <TooltipContent side="top">Sign out</TooltipContent>
      </Tooltip>
    </div>
  )
}

/* ---------- desktop sidebar ---------- */

export default function Sidebar({ user, role, showBell }: { user: string; role: Role; showBell: boolean }) {
  const nav = navFor(role)
  const [collapsed, setCollapsed] = useState(false)

  // restore collapse preference after mount (avoids SSR hydration mismatch)
  useEffect(() => {
    setCollapsed(localStorage.getItem('sidebar-collapsed') === '1')
  }, [])

  const setAndStore = useCallback((next: boolean) => {
    setCollapsed(next)
    try {
      localStorage.setItem('sidebar-collapsed', next ? '1' : '0')
    } catch {
      /* private mode: preference just isn't remembered */
    }
  }, [])

  return (
    <TooltipProvider delay={150}>
      <aside
        className={cn(
          // No width transition: animating width reflows the whole page every frame.
          'hidden h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex',
          collapsed ? 'w-16' : 'w-60'
        )}
        data-collapsed={collapsed}
        aria-label="Main navigation"
      >
        <div className={cn('flex h-14 items-center', collapsed ? 'justify-center px-2' : 'justify-between gap-2 pl-4 pr-2')}>
          <Brand compact={collapsed} />
          {!collapsed && (
            <button onClick={() => setAndStore(true)} aria-label="Collapse sidebar" className={iconButton}>
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className={cn('pb-2', collapsed ? 'px-2' : 'px-3')}>
          <SearchButton rail={collapsed} />
        </div>

        <nav className={cn('flex-1 overflow-y-auto py-2', collapsed ? 'px-2' : 'px-3')}>
          <NavList nav={nav} rail={collapsed} onExpandRail={() => setAndStore(false)} />
        </nav>

        <div className={cn('border-t border-sidebar-border py-3', collapsed ? 'px-2' : 'px-3')}>
          <UserFooter user={user} role={role} rail={collapsed} showBell={showBell} />
          {collapsed && (
            <div className="mt-1 flex justify-center">
              <Tooltip>
                <TooltipTrigger
                  render={<button onClick={() => setAndStore(false)} aria-label="Expand sidebar" className={iconButton} />}
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </TooltipTrigger>
                <TooltipContent side="right">Expand</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </aside>
    </TooltipProvider>
  )
}
