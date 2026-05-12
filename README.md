# Pi-Hole Central

A centralised dashboard for monitoring and managing multiple Pi-Hole v6 instances from a single interface.

> **Built entirely with [Claude Code](https://claude.ai/code)** — Anthropic's agentic coding tool.

---

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/pihole-central.git
cd pihole-central
cp .env.example .env
```

Edit `.env` and fill in the required values (see [Environment Variables](#environment-variables) below), then:

```bash
docker compose up -d --build
```

Open **http://localhost:3100** in your browser.

> **Default credentials: `admin` / `admin`**
> Change your password immediately after first login via **Settings → Account**.

---

## Environment Variables

Copy `.env.example` to `.env` and set these values:

| Variable | Required | Description |
|---|---|---|
| `NEXTAUTH_SECRET` | ✅ | Random secret for JWT signing. Generate: `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | ✅ | Key for encrypting Pi-Hole credentials. Generate: `openssl rand -hex 32` |
| `NEXTAUTH_URL` | ✅ | Full URL where the dashboard is accessible |
| `DATABASE_URL` | — | SQLite path — leave as default unless you change the volume mount |

**`NEXTAUTH_URL`**: Set this to the URL you use to access the dashboard. If running on your local machine it can stay as `http://localhost:3100`. If hosted on another server (e.g. `http://10.0.0.50:3100`) set it to that address — login will not work correctly otherwise.

Example `.env`:

```env
NEXTAUTH_SECRET=your-generated-secret-here
NEXTAUTH_URL=http://10.0.0.50:3100
ENCRYPTION_KEY=your-generated-key-here
DATABASE_URL=file:/app/data/pihole-central.db
```

---

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

### Access Control
Two role levels with enforced server-side restrictions:

| Feature | Admin | Viewer |
|---|---|---|
| Overview Dashboard | Read + control | Read only |
| Query Log | ✅ | ✅ |
| Enable/disable blocking | ✅ | — |
| Gravity update | ✅ | — |
| Domain Management | ✅ | — |
| Instance Management | ✅ | — |
| Notifications | ✅ | — |
| Alerts | ✅ | — |
| General Settings | ✅ | — |
| User Management | ✅ | — |

Viewers are restricted to Overview and Query Log — all other routes redirect to the dashboard.

### User Management (Admin only)
- Create and delete users
- Assign roles (admin or viewer)
- Change any user's password
- All users can change their own password via the Account page

---

## Stack

- **Framework**: Next.js (App Router), TypeScript, React 19
- **Auth**: NextAuth.js v5 — Credentials provider, JWT sessions
- **Database**: SQLite via Drizzle ORM (better-sqlite3)
- **UI**: shadcn/ui, Tailwind CSS v4
- **Deployment**: Docker (multi-stage build, standalone output)

---

## Pi-Hole Compatibility

Requires **Pi-Hole v6** — the v6 REST API is used for all data fetching and control operations.

---

## Built with Claude Code

This project was built entirely using [Claude Code](https://claude.ai/code), Anthropic's agentic coding tool. The full stack — from authentication and encrypted credential storage to the SSE live-data pipeline and role-based access control — was implemented through an iterative conversation with Claude without manually writing code.

---

## License

[MIT](LICENSE)
