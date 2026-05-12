# Pi-Hole Central

A centralised dashboard for monitoring and managing multiple Pi-Hole v6 instances from a single interface.

## Features

### Overview Dashboard
- Aggregated stats across all instances: total queries, blocked queries, block rate, active clients
- Per-instance status cards showing online/offline state, blocking toggle, and key metrics
- Live updates via Server-Sent Events (SSE) — no page refresh needed
- Bulk enable/disable blocking across all instances at once
- Bulk gravity update (ad-list sync) across all instances

### Query Log
- Unified query log aggregated from all Pi-Hole instances
- Search by domain or client
- Pagination for large result sets
- Shows query type, status (blocked/allowed), and source instance

### Domain Management
- View and manage allow/deny lists across all instances simultaneously
- Add or remove domains from allowlists and blocklists
- Changes are pushed to all configured instances

### Instance Management
- Add, edit, and remove Pi-Hole instances
- Credentials (API tokens) are stored AES-256-GCM encrypted in the database
- Per-instance enable/disable blocking toggle
- Per-instance gravity update trigger
- Live connectivity status indicator

### Notifications
Supports multiple notification channels for status alerts:
- **Gotify** — self-hosted push notifications
- **Pushover** — mobile push notifications
- **Telegram** — bot message notifications
- **Email** — SMTP-based notifications

Channels can be tested directly from the settings page.

### Alerts
- Define alert rules triggered by query thresholds or instance offline events
- Configurable cooldown periods to prevent alert spam
- Alerts fire to any configured notification channel

### General Settings
- Application-level configuration
- Polling interval for instance data refresh

### Access Control
Two role levels with enforced server-side restrictions:

| Feature | Admin | Viewer |
|---|---|---|
| Overview Dashboard | Read + control | Read only |
| Query Log | Yes | Yes |
| Enable/disable blocking | Yes | No |
| Gravity update | Yes | No |
| Domain Management | Yes | No |
| Instance Management | Yes | No |
| Notifications | Yes | No |
| Alerts | Yes | No |
| General Settings | Yes | No |
| User Management | Yes | No |

Viewers are restricted to Overview and Query Log only — all other routes redirect to the dashboard.

### User Management (Admin only)
- Create and delete users
- Assign roles (admin or viewer)
- Change any user's password
- All users can change their own password via the Account page

## Stack

- **Framework**: Next.js (App Router), TypeScript, React
- **Auth**: NextAuth.js v5 — Credentials provider, JWT sessions
- **Database**: SQLite via Drizzle ORM
- **UI**: shadcn/ui, Tailwind CSS v4
- **Deployment**: Docker

## Deployment

The app is configured for Docker. Required environment variables:

| Variable | Description |
|---|---|
| `AUTH_SECRET` | Random secret for NextAuth.js JWT signing |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM credential encryption |
| `DATABASE_URL` | Path to SQLite database file |

On first run the database is auto-migrated and a default admin account is created.

## Pi-Hole Compatibility

Requires Pi-Hole v6 — the API used is the v6 REST API.
