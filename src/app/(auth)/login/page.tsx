'use client'

import { useEffect, useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ShieldCheck } from 'lucide-react'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const router = useRouter()

  // Read once on the client (useSearchParams would need a Suspense boundary).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('reason') === 'password-changed') {
      setNotice('Password changed. Sign in with your new password.')
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const result = await signIn('credentials', {
      username,
      password,
      redirect: false,
    })
    if (result?.error) {
      setError('Invalid username or password')
      setLoading(false)
    } else {
      router.push('/')
      router.refresh()
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Pi-hole Central</h1>
            <p className="mt-1 text-sm text-muted-foreground">Sign in to your dashboard</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="surface space-y-4 p-6">
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              required
              className="h-9"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="h-9"
            />
          </div>
          {notice && !error && (
            <p role="status" className="text-center text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  )
}
