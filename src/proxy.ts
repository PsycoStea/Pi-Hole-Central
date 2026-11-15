import { auth } from '@/lib/auth'

// Next 16 proxy (formerly middleware.ts). Runs on the Node.js runtime, so it
// uses the FULL auth: its jwt callback re-reads the user's role from SQLite on
// every request, so a demoted or deleted user is redirected away from admin
// pages on their next navigation, not after their session cookie refreshes.
// Page access rules live in authConfig.callbacks.authorized (auth.config.ts).
//
// It must sit next to `app` (src/proxy.ts). The old root-level middleware.ts
// was outside src/, so `next dev` never ran it; production builds did.
export default auth

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
