import type { NextAuthConfig } from 'next-auth'

// Viewers see the read-only dashboards plus their own account page (to change
// their password; /api/users/me/password only needs a session).
const VIEWER_ALLOWED = ['/', '/queries', '/settings/account']

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Cross-site request refusal (audit R1-NV1, FIX-PLAN P3.6). Session cookies are
// SameSite=Lax, and every other subdomain of the same registrable domain (e.g.
// *.example.com) is SAME-SITE to this one, so a page on any of them could send a cookie-
// carrying text/plain POST. State-changing API calls, and the live stream, must
// come from this origin:
// - Sec-Fetch-Site (sent by every current browser) must be same-origin or none;
//   same-site and cross-site are refused.
// - Without it, an Origin header must name this host.
// - A request with neither header is not from a browser page, so it carries no
//   ambient cookie a third party could abuse; it is let through.
// /api/auth/* is left to Auth.js, which has its own CSRF token.
function crossSiteRefusal(request: Request): Response | null {
  const site = request.headers.get('sec-fetch-site')
  if (site) {
    if (site === 'same-origin' || site === 'none') return null
    return Response.json({ error: 'Cross-site request refused' }, { status: 403 })
  }
  const origin = request.headers.get('origin')
  if (!origin) return null
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    originHost = '' // "null" or garbage: refuse
  }
  // Host, not X-Forwarded-Host: NPM sets Host to the public name and passes a
  // client-sent X-Forwarded-Host through untouched.
  const host = request.headers.get('host')
  if (originHost && originHost === host) return null
  return Response.json({ error: 'Cross-site request refused' }, { status: 403 })
}

export const authConfig = {
  trustHost: true,
  pages: { signIn: '/login' },
  callbacks: {
    session({ session, token }) {
      if (session.user) {
        session.user.role = (token.role ?? 'viewer') as 'admin' | 'viewer'
      }
      return session
    },
    authorized({ auth, request }) {
      const { nextUrl } = request
      const isLoggedIn = !!auth?.user
      // Whole path segments only: startsWith('/login') also matched '/loginX'.
      const under = (p: string) => nextUrl.pathname === p || nextUrl.pathname.startsWith(p + '/')
      const isLoginPage = under('/login')
      const isApiAuth = under('/api/auth')
      if (isApiAuth) return true
      if (under('/api') && (!SAFE_METHODS.has(request.method) || under('/api/events'))) {
        const refused = crossSiteRefusal(request)
        if (refused) return refused
      }
      if (!isLoggedIn && !isLoginPage) {
        // API callers get a JSON 401, not a redirect to the login page: a
        // followed redirect returned the login HTML with 200, which the client's
        // api() helper treated as success, so a save after session expiry could
        // report "saved" without having happened.
        if (nextUrl.pathname.startsWith('/api/')) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }
        return false
      }
      if (isLoggedIn && isLoginPage) return Response.redirect(new URL('/', nextUrl))

      if (auth?.user?.role === 'viewer') {
        const isAllowed =
          VIEWER_ALLOWED.some(p => (p === '/' ? nextUrl.pathname === '/' : under(p))) ||
          // The instance detail page is role-aware (admin actions hidden). Its
          // /unbound sub-page is admin-only, so match exactly one segment.
          /^\/instances\/[^/]+\/?$/.test(nextUrl.pathname)
        const isApi = nextUrl.pathname.startsWith('/api/')
        if (!isAllowed && !isApi) return Response.redirect(new URL('/', nextUrl))
      }

      return true
    },
  },
  providers: [],
} satisfies NextAuthConfig
