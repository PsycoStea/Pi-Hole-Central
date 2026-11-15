'use client'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  // Same footprint before mount, so the row doesn't shift when it appears.
  if (!mounted) return <span className="inline-block h-8 w-8" aria-hidden />

  const dark = resolvedTheme === 'dark'
  return (
    <button
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}
