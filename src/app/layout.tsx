import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import { startPollingOnce } from '@/lib/polling/init'
import { startUnboundPollingOnce } from '@/lib/unbound/init'
import { Providers } from '@/components/providers'

startPollingOnce()
startUnboundPollingOnce()

// One family for UI and headings (headings differ by weight and size only).
const geistSans = Geist({ variable: '--font-sans', subsets: ['latin'] })

const geistMono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Pi-Hole Central',
  description: 'Centralised dashboard for monitoring multiple Pi-Hole instances',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  )
}
