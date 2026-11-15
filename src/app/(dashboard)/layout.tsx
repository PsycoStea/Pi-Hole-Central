import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import AppShell from '@/components/dashboard/AppShell'
import CommandPalette from '@/components/dashboard/CommandPalette'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session) redirect('/login')

  // Least privilege if a role is ever missing; the API enforces roles anyway.
  const role = (session.user?.role ?? 'viewer') as 'admin' | 'viewer'

  return (
    <>
      <AppShell user={session.user?.name ?? 'User'} role={role}>
        {children}
      </AppShell>
      <CommandPalette role={role} />
    </>
  )
}
