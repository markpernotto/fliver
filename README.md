# fliver

Personal forecasting service for Lyft XL pickups at Redmond Municipal Airport (RDM / KRDM). Predicts high-value driving windows using FlightAware AeroAPI scheduled-arrivals data, then surfaces them in a mobile app with push notifications.

Single-user by design. Lyft has no driver-facing API, so this works by predicting demand from external signals (flight arrivals first; weather, pass closures, events, Mt. Bachelor in later phases) and learning from manually logged shift/ride outcomes.

## Stack

- **api/** — Next.js (app router, TypeScript) on Vercel
- **mobile/** — Flutter (iOS only via TestFlight) — scaffolded in Phase 3
- **Postgres** — local via Docker in dev, Neon free tier in prod
- **Cron** — GitHub Actions hitting Vercel cron endpoints (Vercel Hobby cron is daily-only; GitHub Actions does hourly free)
- **Push** — direct APNs via `apns2` (no Firebase) — Phase 4

## Phase status

- [x] Phase 1 — backend skeleton: schema, scoring, sync-arrivals + today endpoints
- [ ] Phase 2 — deploy: Vercel + Neon + GitHub Actions cron
- [ ] Phase 3 — Flutter shell on TestFlight (Today / Log Ride / Log Shift)
- [ ] Phase 4 — APNs push notifications
- [ ] Phase 5 — additional signals: NOAA weather, ODOT incidents, Mt. Bachelor, events

## Local dev

Prerequisites: Node 20+, pnpm. (Docker optional — only for forkers who'd rather run Postgres locally.)

### Quickstart with Neon (recommended)

```bash
# 1. Sign up at neon.tech, create a project named "fliver", copy the connection string
#    (it looks like: postgresql://user:pass@ep-xxx.us-west-2.aws.neon.tech/fliver?sslmode=require)

# 2. Install + configure
cd api
pnpm install
cp .env.example .env       # paste your Neon URL into DATABASE_URL; set CRON_SECRET to any random string

# 3. Migrate
pnpm prisma migrate dev --name init

# 4. Seed synthetic KRDM arrivals so /today returns data without an AeroAPI key
pnpm prisma:seed

# 5. Run dev server
pnpm dev

# 6. Try it
curl http://localhost:3000/api/today | jq
```

### Alternative: local Postgres via Docker

```bash
docker compose up -d
# DATABASE_URL stays as the default in .env.example
cd api && pnpm install && pnpm prisma migrate dev --name init && pnpm prisma:seed && pnpm dev
```

## API surface (Phase 1)

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/today` | Top 3 + all merged windows for next 24h |
| `GET`  | `/api/forecast?days=7` | Scored windows grouped by local calendar day, next N days (default 7, max 10) |
| `POST` | `/api/cron/sync-arrivals?type=daily\|hourly` | Pull AeroAPI + recompute windows. Daily pulls 7 days forward and prunes past flights. Gated on `Authorization: Bearer $CRON_SECRET`. |
| `POST` | `/api/refresh?date=YYYY-MM-DD` | On-demand single-day refresh (~$0.005 per call). Defaults to today in Pacific time. Gated on `Authorization: Bearer $CRON_SECRET`. |
| `POST` | `/api/shifts` | Log a shift |
| `GET`  | `/api/shifts` | List recent shifts |
| `POST` | `/api/rides` | Log an individual ride |
| `GET`  | `/api/rides` | List recent rides |

Manual trigger of sync against your local DB:

```bash
# Daily snapshot (pulls 7 days, prunes past flights)
curl -X POST 'http://localhost:3000/api/cron/sync-arrivals?type=daily' \
  -H "Authorization: Bearer $CRON_SECRET"

# On-demand refresh for a specific day
curl -X POST 'http://localhost:3000/api/refresh?date=2026-05-17' \
  -H "Authorization: Bearer $CRON_SECRET"

# Week-ahead view
curl 'http://localhost:3000/api/forecast?days=7' | jq
```

## AeroAPI cost model

On AeroAPI Personal tier ($5/mo free credit, `$0.005` per result set for `/scheduled_arrivals`):

| Trigger | When | Window | Pages/call | Calls/mo | Cost/mo |
|---|---|---|---|---|---|
| daily-snapshot | 5 AM Pacific (GitHub Actions cron) | next 7 days | ~19 | 30 | ~$2.85 |
| on-demand refresh | when you pull-to-refresh a specific day in the app (Phase 3) | that day only (24h) | ~1 | variable | ~$0.05 per tap |
| pre-window boost | 30 min before a high-score window (Phase 4, folded into notify) | that window only | ~1 | ~60 | ~$0.30 |

Total ≈ $3.20/mo at typical usage, comfortably under the $5 Personal credit. Every call is logged in `api_call_log` with an estimated cost — query it any time to see the trajectory:

```sql
SELECT date_trunc('day', called_at) AS day,
       provider,
       tier,
       SUM(estimated_cost_cents) / 100.0 AS dollars
FROM api_call_log
GROUP BY 1, 2, 3
ORDER BY 1 DESC;
```

Flight retention: the daily sync prunes any flight whose scheduled (and estimated, if present) arrival is more than 6 hours in the past. Keeps Neon small. Shift/ride `factors_snapshot` JSON columns preserve the scoring inputs at shift time, so we don't need historical flights to learn from outcomes later.

## See also

- [rdm-driver-forecast-plan.md](./rdm-driver-forecast-plan.md) — original design document. Stack and polling have been revised; kept here as design history.
