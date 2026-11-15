'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Menu, Search, X } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/hooks/use-media-query'
import NotificationBell from '@/components/dashboard/NotificationBell'
import { openCommandPalette } from '@/components/dashboard/command-palette-events'
import Sidebar, { Brand, NavList, SearchButton, UserFooter, navFor, type Role } from './Sidebar'

const iconButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer'

/**
 * Layout chrome. Desktop (lg and up): the sidebar. Below that: a sticky top
 * bar with a menu button that opens the same navigation in a drawer.
 * The notification bell mounts exactly once (it polls), in whichever is shown.
 */
export default function AppShell({
  user,
  role,
  children,
}: {
  user: string
  role: Role
  children: React.ReactNode
}) {
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const pathname = usePathname()
  const nav = navFor(role)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)

  // The layout does not remount on client navigation: close the drawer and
  // start the new page at the top.
  useEffect(() => {
    setDrawerOpen(false)
    mainRef.current?.scrollTo({ top: 0 })
  }, [pathname])

  // Growing past the breakpoint with the drawer open would leave it orphaned.
  useEffect(() => {
    if (isDesktop) setDrawerOpen(false)
  }, [isDesktop])

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar user={user} role={role} showBell={isDesktop === true} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar: phones and tablets */}
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1 border-b border-border bg-background/95 px-2 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80 lg:hidden">
          <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <DialogPrimitive.Trigger className={iconButton} aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </DialogPrimitive.Trigger>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-[var(--dur-panel)] ease-[var(--ease-drawer)] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
              <DialogPrimitive.Popup
                aria-label="Navigation"
                className="fixed inset-y-0 left-0 z-50 flex w-[18rem] max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar shadow-xl outline-none transition-transform duration-[var(--dur-panel)] ease-[var(--ease-drawer)] data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full motion-reduce:transition-none"
              >
                <TooltipProvider delay={150}>
                  <div className="flex h-14 items-center justify-between pl-4 pr-2">
                    <Brand />
                    <DialogPrimitive.Close className={iconButton} aria-label="Close navigation">
                      <X className="h-5 w-5" />
                    </DialogPrimitive.Close>
                  </div>
                  <div className="px-3 pb-2">
                    <SearchButton />
                  </div>
                  <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label="Main navigation">
                    <NavList nav={nav} />
                  </nav>
                  <div className="border-t border-sidebar-border px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                    <UserFooter user={user} role={role} showBell={false} />
                  </div>
                </TooltipProvider>
              </DialogPrimitive.Popup>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>

          <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
            <Brand />
          </div>

          <button onClick={openCommandPalette} className={iconButton} aria-label="Search">
            <Search className="h-[1.125rem] w-[1.125rem]" />
          </button>
          {isDesktop === false && role === 'admin' && <NotificationBell />}
        </header>

        <main ref={mainRef} id="main" className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
