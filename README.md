# GPL VPMO Training Scheduler

Single-page app for Guyana Power & Light's VPMO onboarding and training program.

## Local run

```bash
npm start
# open http://localhost:3000
```

No dependencies — pure Node `http` module.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick this repo.
3. Railway auto-detects Node via `package.json`, runs `npm start`, and assigns a `$PORT`.
4. Under **Settings → Networking**, click **Generate Domain** to get a public URL.

Alternatively, with the Railway CLI:

```bash
npm i -g @railway/cli
railway login
railway init
railway up
railway domain
```

## Data storage

All data (user accounts, bookings, notes, materials, training status) lives in each visitor's browser `localStorage`. Deploying to Railway gives you a public URL for the UI, but **data is not shared** across devices or users — it's per-browser.

If you need shared data (one trainer seeing every trainee's real registrations), you'll need a real backend + database. This repo is the frontend only.

## Credentials

- **Trainer dashboard password:** `vpmo2026` (change in `index.html`, search for `TRAINER_PASSWORD`).
- Trainee accounts are created via the in-app signup flow.
