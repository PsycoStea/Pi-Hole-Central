'use client'

import { useEffect, useState } from 'react'

/**
 * Whether a media query matches. `null` until mounted, so server and first
 * client render agree; callers render nothing query-dependent while null.
 */
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const apply = () => setMatches(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [query])
  return matches
}
