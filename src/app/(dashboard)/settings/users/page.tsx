'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { toast } from 'sonner'
import { Trash2, ShieldCheck, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import PageHeader from '@/components/dashboard/PageHeader'

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
    const msg = newR === 'admin'
      ? `Make "${user.username}" an admin? Admins can change every setting, including Pi-hole blocking and other users.`
      : `Make "${user.username}" a viewer? They will lose access to all settings.`
    if (!window.confirm(msg)) return
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
        <PageHeader title="Users" />
        <div className="surface p-8 text-center text-muted-foreground text-sm">
          You do not have permission to manage users.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="Manage accounts and access levels" />

      {/* User table */}
      <div className="surface overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
        ) : (
          <table className="w-full min-w-[32rem] text-sm">
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
                          ? 'bg-primary/15 text-primary border-primary/25 hover:bg-primary/25'
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
                      className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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
      <div className="surface p-6 space-y-4 max-w-md">
        <h2 className="text-sm font-semibold">Create User</h2>
        <form onSubmit={createUser} className="space-y-3">
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="Username"
            required
            className="w-full px-3 py-2 rounded-lg bg-transparent dark:bg-input/30 border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring/50"
          />
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Password (min. 8 characters)"
            required
            minLength={8}
            className="w-full px-3 py-2 rounded-lg bg-transparent dark:bg-input/30 border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring/50"
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
                    ? 'bg-primary/20 border-primary/50 text-primary'
                    : 'bg-muted/50 border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            type="submit"
            disabled={creating || !newUsername || !newPassword}
            className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {creating ? 'Creating…' : 'Create User'}
          </button>
        </form>
      </div>
    </div>
  )
}
