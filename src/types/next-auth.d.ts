import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: 'admin' | 'viewer'
      /** token_version the session was minted with (server-side checks only). */
      tv?: number
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string
    role?: 'admin' | 'viewer'
    /** users.token_version at sign-in; a mismatch ends the session. */
    tv?: number
  }
}
