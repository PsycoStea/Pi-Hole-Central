import type { NextAuthConfig } from 'next-auth'

const VIEWER_ALLOWED = ['/', '/queries']

export const authConfig = {
  trustHost: true,
  pages: { signIn: '/login' },
  callbacks: {
    session({ session, token }) {
      if (session.user) {
        session.user.role = (token.role ?? 'admin') as 'admin' | 'viewer'
      }
      return session
    },
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user
      const isLoginPage = nextUrl.pathname.startsWith('/login')
      const isApiAuth = nextUrl.pathname.startsWith('/api/auth')
      if (isApiAuth) return true
      if (!isLoggedIn && !isLoginPage) return false
      if (isLoggedIn && isLoginPage) return Response.redirect(new URL('/', nextUrl))

      if (auth?.user?.role === 'viewer') {
        const isAllowed = VIEWER_ALLOWED.some(p =>
          p === '/' ? nextUrl.pathname === '/' : nextUrl.pathname.startsWith(p)
        )
        const isApi = nextUrl.pathname.startsWith('/api/')
        if (!isAllowed && !isApi) return Response.redirect(new URL('/', nextUrl))
      }

      return true
    },
  },
  providers: [],
} satisfies NextAuthConfig
