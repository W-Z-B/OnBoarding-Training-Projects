# GPL VPMO Training Scheduler

Postgres-backed training registration app for Guyana Power & Light's VPMO onboarding program.

Features:
- Trainee signup/login (real-name enforcement, salted SHA-256 password hashing)
- Booking form with 5 training levels and unit-head team rostering
- Monthly calendar, per-day slot list, registrations table
- Status tracking (Scheduled / Completed / Postponed / Cancelled)
- Per-person and per-unit progress charts
- Study notes + study materials (files up to 4 MB) per booking
- Trainer dashboard behind a password gate (`vpmo2026` by default)
- Light/dark theme
- Everything persisted in Postgres

## Deploy to Railway (live Postgres)

1. **Fork / use this repo** — `W-Z-B/OnBoarding-Training-Projects`.
2. On [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick the repo.
3. In the project, click **+ New** → **Database** → **Add PostgreSQL**. Railway will set `DATABASE_URL` on the web service automatically.
4. (Optional) In the web service → **Variables**, set:
   - `TRAINER_PASSWORD` — override default (`vpmo2026`)
5. **Settings → Networking → Generate Domain** — you get a public URL.
6. Railway runs `npm ci && npm start`. On first boot, the server auto-migrates the schema from `schema.sql`.

Done — visit the domain, sign up, start booking.

### Railway CLI alternative

```bash
npm i -g @railway/cli
railway login
railway init
railway add --database postgres
railway up
railway domain
```

## Local development

```bash
npm install
export DATABASE_URL="postgres://user:pass@localhost:5432/gpl"
# or on Windows PowerShell:
#   $env:DATABASE_URL="postgres://user:pass@localhost:5432/gpl"
npm run migrate    # one-time schema setup
npm start          # runs http://localhost:3000
```

To use an un-encrypted local Postgres, also set `PGSSL=disable`.

## Data model (Postgres)

- `users` — accounts (username, email, phone, unit, full_name, salt, password_hash)
- `sessions` — HTTP-only cookie sessions
- `bookings` — training registrations
- `team_members` — names a unit head is sending
- `study_notes` — text notes per booking
- `materials` — file uploads (base64-encoded blobs) per booking

Schema is in [`schema.sql`](schema.sql). Migrations run automatically on server boot when `DATABASE_URL` is present.

## Credentials

- **Trainer dashboard password:** `vpmo2026` (override via `TRAINER_PASSWORD` env var).
- Trainee accounts are created via the in-app signup flow.

## Tech

- Backend: Node 18+ (`http`, `pg`) — no framework, ~450 lines.
- Frontend: vanilla HTML + inline CSS/JS, zero build step.
