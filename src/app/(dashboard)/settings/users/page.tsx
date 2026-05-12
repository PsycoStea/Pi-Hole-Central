'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { toast } from 'sonner'
import { Trash2, ShieldCheck, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'

interface UserRow {
  id: string
  username: string
  role: 'admin' | 'viewer'
  createdAt: string
}

export default function UsersPage() {
  const { data: session } = useSession()
  const [userList, setUserList] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)

  // Create form state
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<'admin' | 'viewer'>('viewer')
  const [creating, setCreating] = useState(false)

  const isAdmin = session?.user?.role === 'admin'

  async function fetchUsers() {
    try {
      const res = await fetch('/api/users')
      if (res.ok) setUserList(await res.json().then((d) => d.users))
    } catch {
      toast.error('Failed to load users')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchUsers() }, [])

  async function toggleRole(user: UserRow) {
    const newR = user.role === 'admin' ? 'viewer' : 'admin'
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newR }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success(`${user.username} is now ${newR}`)
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update role')
    }
  }

  async function deleteUser(user: UserRow) {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/users/${user.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success(`Deleted ${user.username}`)
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete user')
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      toast.success(`Created user ${newUsername}`)
      setNewUsername('')
      setNewPassword('')
      setNewRole('viewer')
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold gradient-text">Users</h1>
        <div className="glass-card p-8 text-center text-muted-foreground text-sm">
          You do not have permission to manage users.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold gradient-text">Users</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage accounts and access levels</p>
      </div>

      {/* User table */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Username</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Role</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {userList.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors">
                  <td className="px-4 py-3 font-medium">{u.username}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleRole(u)}
                      disabled={u.id === session?.user?.id}
                      title={u.id === session?.user?.id ? 'Cannot change your own role' : 'Click to toggle role'}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer',
                        u.id === session?.user?.id && 'cursor-default opacity-60',
                        u.role === 'admin'
                          ? 'bg-blue-500/15 text-blue-400 border-blue-500/25 hover:bg-blue-500/25'
                          : 'bg-muted text-muted-foreground border-border hover:bg-accent'
                      )}
                    >
                      {u.role === 'admin'
                        ? <><ShieldCheck className="h-3 w-3" /> Admin</>
                        : <><Eye className="h-3 w-3" /> Viewer</>
                      }
                    </button>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => deleteUser(u)}
                      disabled={u.id === session?.user?.id}
                      title={u.id === session?.user?.id ? 'Cannot delete your own account' : 'Delete user'}
                      className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create user form */}
      <div className="glass-card p-6 space-y-4 max-w-md">
        <h2 className="text-sm font-semibold">Create User</h2>
        <form onSubmit={createUser} className="space-y-3">
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="Username"
            required
            className="w-full px-3 py-2 rounded-lg bg-black/20 border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          />
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Password (min. 8 characters)"
            required
            minLength={8}
            className="w-full px-3 py-2 rounded-lg bg-black/20 border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          />
          <div className="flex gap-2">
            {(['viewer', 'admin'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setNewRole(r)}
                className={cn(
                  'flex-1 py-2 rounded-lg text-xs font-medium border transition-colors capitalize',
                  newRole === r
                    ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                    : 'bg-black/20 border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            type="submit"
            disabled={creating || !newUsername || !newPassword}
            className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-gradient-to-r from-blue-600 to-blue-500 text-white hover:from-blue-500 hover:to-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {creating ? 'Creating…' : 'Create User'}
          </button>
        </form>
      </div>
    </div>
  )
}
