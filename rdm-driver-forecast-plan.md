# RDM Driver Forecast — Project Plan

> **For: Claude Code**
> **Status: scoping / pre-implementation**
> **Working name: `rdm-driver-forecast`** (rename freely)

## TL;DR

Build a personal forecasting service that recommends specific time windows to drive Lyft XL out of Bend, OR, based on external demand signals (flight arrivals, weather, Mt. Bachelor status, local events). Lyft offers no driver-facing API, so the system predicts demand from external data and learns from manually-logged shift outcomes.

Stack: NestJS + Postgres + Flutter on AWS. Single-user, mobile-first, push-notification driven.

---

## Context

- **Driver profile:** Full-stack engineer driving Lyft XL exclusively, Ford Transit van (10-pax capacity, but Lyft caps at 7).
- **Geography:** Lives in Bend, OR. Primary airport is Redmond Municipal (RDM / Roberts Field), ~25 min drive.
- **Existing stack preference:** Flutter, React, NestJS, PostgreSQL, AWS.
- **Driving model:** Concentrated high-value windows, not clock-in-and-grind. Idle time has real cost (van fuel + depreciation + opportunity cost).

## Problem

Lyft does not expose driver-facing data programmatically. At small airports like RDM, the in-app planner and FIFO queue features are sparse or inactive outside the main 11am–1pm flight bank. The user needs to know **when to go online** to maximize $/hr given:

- High per-ride pay for XL ($25–40 typical for RDM→Bend, ~16 mi / ~25 min)
- Low overall ride volume — RDM is ~30–50 flights/day, ~3,000 pax/day
- Distinct demand windows (airport bank, brewery/dining, Mt. Bachelor apré-ski, events, weather-stranded travelers)
- Significant fixed cost per hour online

## Goal

A personal forecasting service that:

1. Pulls external demand signals on a schedule
2. Computes scored time windows for the next 24–72 hours
3. Surfaces top windows in a mobile UI with push notifications before they start
4. Accepts post-shift earnings input to close the feedback loop and tune scoring weights over time

**Success metric:** Shift ≥2 hours/week of online time from low-value to high-value windows within 30 days of regular use.

## Empirical baseline (from research)

| Fact | Value | Source / Notes |
|---|---|---|
| RDM daily flights | ~30–50 | iFly, FlyRDM |
| RDM daily passengers | ~3,000 | iFly |
| RDM carriers / hubs | Alaska, Delta, United, American — SEA, SLC, DEN, PHX, SFO | |
| RDM in-app queue window | ~11:00 AM – 1:00 PM only | User observation, matches mid-day flight bank |
| Bend Lyft market | Upfront Pay enabled | Lyft Bend driver page |
| Oregon driver minimum pay law | None (SB 1166 died in committee June 2025) | Oregon Legislature |
| Lyft commission cap | 30% (drivers guaranteed ≥70% of rider payments) | Lyft 2024 pay standard |
| Bend XL rate estimates | ~$1.05–1.50/mile + $0.18–0.25/min | Inferred from low-cost-market rates × XL multiplier (1.5–2x); Lyft does not publish per-market rates |
| Realistic XL gross | $25–35/hr in high-value windows | Industry data |
| Realistic net after costs | 40–55% of gross (Transit van) | Fuel + depreciation + SE tax |

## Constraints

1. **No Lyft API access for drivers.** Lyft Concierge API is business-only (companies booking rides for employees). No driver auth flow, no driver-side data exposure.
2. **No app scraping.** Violates ToS, risks deactivation. Hard out.
3. **All data sources must be external and legally accessible.**
4. **Manual logging required for outcomes.** User logs gross earnings + ride count per shift via the app.
5. **Single user.** No multi-tenancy needed in v1. Auth can be trivial.

## Data sources

| Source | Purpose | Method | Cost |
|---|---|---|---|
| **FlightAware AeroAPI** | RDM arrivals next 24h (origin, aircraft, on-time status) | REST | Free tier: 500 queries/mo (fits comfortably under the polling policy below) |
| **NOAA NWS API** | Bend forecast + Cascade pass conditions | REST, no key | Free |
| **Mt. Bachelor conditions** | Lift status, snow report, hours | HTML scrape (Cheerio) | Free |
| **Visit Central Oregon events** | Festivals, concerts, weddings | HTML scrape | Free |
| **BendTicket.com** | Event calendar | HTML scrape | Free |
| **ODOT TripCheck** | Hwy 97/20 status (closures = demand spike) | Public API | Free |
| **User shift logs** | Outcome variable (earnings, rides) | Manual via Flutter UI | n/a |

**Note on aircraft → passenger estimates:** Maintain a small lookup table for common RDM aircraft (737-800: ~160, A319: ~128, A320: ~150, E175: ~76, CRJ-700: ~70, CRJ-900: ~76). Origin code → `is_leisure_origin` flag (DEN/SLC in winter = ski; SFO/LAX weekends = leisure; business hubs midweek = lower XL value).

## Polling policy

RDM operates roughly **5:30 AM – 11:00 PM**. There are no overnight arrivals worth tracking, and flight schedules don't change every 30 minutes — what changes is delay/cancellation status on near-term flights. The polling strategy reflects both facts to stay under the 500 query/month free tier comfortably.

**Three-tier polling for FlightAware AeroAPI:**

```typescript
type PollingTier = {
  name: string;
  cron: string;          // when this tier runs
  scope: string;         // what it fetches
  estCallsPerMonth: number;
};

const POLLING_POLICY: PollingTier[] = [
  {
    name: 'daily-snapshot',
    cron: '0 5 * * *',  // 5:00 AM every day
    scope: 'Full 36h scheduled-arrivals dump for KRDM',
    estCallsPerMonth: 30,
  },
  {
    name: 'status-refresh',
    cron: '0 6-21 * * *',  // hourly, 6 AM – 9 PM
    scope: 'Re-fetch arrivals expected in next 3 hours',
    estCallsPerMonth: 16 * 30,  // 480
  },
  {
    name: 'pre-window-boost',
    cron: 'dynamic',  // 90 min before each forecasted high-value window
    scope: 'Re-fetch arrivals for that window only',
    triggerCondition: 'forecast_window.score >= 6',
    estCallsPerMonth: 60,  // ~2/day average
  },
];

// Hard guardrails
const MAX_CALLS_PER_DAY = 25;
const MAX_CALLS_PER_MONTH = 450;  // 10% buffer under 500 free tier
```

**Hard rules:**

1. **No polling 11 PM – 5 AM.** Skip the tier entirely; airport is closed.
2. **Track call count in Postgres.** Persist a daily counter; halt non-essential tiers if approaching the monthly cap.
3. **Backoff on errors.** Exponential backoff on 429/5xx; do not retry tight loops.
4. **Deduplicate.** Upsert flights on `source_id` (FlightAware `fa_flight_id`) to avoid double-counting.

**Expected monthly usage:** ~300–400 calls. Well under the 500 free-tier limit, with headroom for the pre-window boost tier.

**Schema addition for tracking:**

```sql
CREATE TABLE api_call_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,        -- 'flightaware' | 'noaa' | etc.
  endpoint TEXT NOT NULL,
  tier TEXT,                     -- 'daily-snapshot' | 'status-refresh' | 'pre-window-boost'
  called_at TIMESTAMPTZ DEFAULT NOW(),
  status_code INT,
  records_returned INT
);

CREATE INDEX idx_api_call_log_provider_date ON api_call_log (provider, called_at);
```

A simple aggregation over `api_call_log` per calendar month per provider gates the schedulers via a `BudgetGuard` service injected into each module.

## Architecture

```
                ┌──────────────────────────────┐
                │  AWS (Lightsail / ECS / EC2) │
                │                              │
[FlightAware] →─┤  NestJS service              │
[NOAA]        →─┤   ├─ Schedulers (cron)       │
[Bachelor]    →─┤   ├─ Scoring engine          │── push (FCM) ──→ [iPhone]
[Events]      →─┤   ├─ REST API                │
[ODOT]        →─┤   └─ Auth (JWT, single user) │
                │                              │
                │  Postgres (RDS small)        │
                │  Redis (optional, BullMQ)    │
                └──────────────────────────────┘
                              ↑
                              │
                  [Flutter app] ── shift logs ──┘
                  ├─ Today (top windows)
                  ├─ Log shift
                  └─ History / accuracy
```

### Backend (NestJS)

- `@nestjs/schedule` for cron jobs
- BullMQ + Redis if retries / job durability matter (otherwise skip Redis in v1)
- Postgres via TypeORM or Prisma (developer choice; Prisma probably nicer for this scale)
- Single-user JWT auth — hardcoded user ID in config for v1, real auth later if shared
- Deployed to AWS Lightsail container ($10/mo) for v1; revisit ECS Fargate if needed

### Frontend (Flutter)

- iOS-first (single user owns an iPhone). Android trivial via Flutter if needed.
- Three primary screens:
  1. **Today** — top 3 windows for next 24h, with score, contributing factors, "set reminder" toggle
  2. **Log shift** — one-screen entry: start/end time, gross $, tip $, ride count, free-text notes
  3. **History** — earnings chart over time, prediction accuracy view (predicted score vs. actual $/hr per shift)
- FCM push notifications fired 30 min before high-score windows, capped 3/day

## Data model

```sql
-- Inbound flights to RDM
CREATE TABLE flights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT,  -- FlightAware fa_flight_id for upsert
  scheduled_arrival TIMESTAMPTZ NOT NULL,
  estimated_arrival TIMESTAMPTZ,
  origin_iata TEXT NOT NULL,
  carrier TEXT,
  flight_number TEXT,
  aircraft_type TEXT,
  estimated_pax INT,
  is_leisure_origin BOOLEAN DEFAULT FALSE,
  pulled_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_id)
);

CREATE INDEX idx_flights_arrival ON flights (estimated_arrival);

-- Weather snapshots (Bend + passes)
CREATE TABLE weather_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  for_timestamp TIMESTAMPTZ NOT NULL,
  bend_temp_f NUMERIC,
  bend_precip_pct INT,
  bend_conditions TEXT,
  pass_snow_in_24h NUMERIC,
  pass_status TEXT, -- 'open' | 'chains_required' | 'closed'
  pulled_at TIMESTAMPTZ DEFAULT NOW()
);

-- Mt. Bachelor daily status
CREATE TABLE bachelor_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  for_date DATE NOT NULL UNIQUE,
  is_open BOOLEAN,
  lifts_open INT,
  lifts_total INT,
  fresh_snow_in NUMERIC,
  base_depth_in NUMERIC,
  closing_time TIME,
  pulled_at TIMESTAMPTZ DEFAULT NOW()
);

-- Local events
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT,
  source_id TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  venue TEXT,
  title TEXT,
  estimated_attendance INT,
  category TEXT,  -- 'festival' | 'concert' | 'wedding' | 'sports' | 'other'
  pulled_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source, source_id)
);

-- Computed forecast windows
CREATE TABLE forecast_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  score NUMERIC NOT NULL CHECK (score >= 0 AND score <= 10),
  factors JSONB NOT NULL,  -- {arrivals: 3.2, bachelor: 2.0, events: 1.0, weather: 0, timing: 1.5}
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (window_start, window_end)
);

CREATE INDEX idx_windows_start ON forecast_windows (window_start);

-- User shift logs (the outcome variable for learning)
CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  gross_earnings_cents INT NOT NULL,
  tip_earnings_cents INT DEFAULT 0,
  ride_count INT NOT NULL,
  notes TEXT,
  predicted_score NUMERIC,  -- snapshot of the window score at shift start
  factors_snapshot JSONB,   -- snapshot of factors for later regression
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shifts_started ON shifts (started_at);
```

## Scoring algorithm (v0, hand-tuned)

Score is 0–10. Compute hourly windows for the next 72 hours, then merge contiguous high-scoring hours into windows.

```typescript
type Factors = {
  arrivals: number;
  bachelor: number;
  events: number;
  weather: number;
  timing: number;
};

function scoreWindow(start: Date, end: Date, signals: Signals): { score: number; factors: Factors } {
  const factors: Factors = { arrivals: 0, bachelor: 0, events: 0, weather: 0, timing: 0 };

  // 1. Airport arrivals — passenger-weighted, leisure-boosted
  const flights = signals.flightsArriving(
    addMinutes(start, -30),  // ride could start 30 min before scheduled arrival
    end
  );
  factors.arrivals = Math.min(
    flights.reduce((acc, f) => {
      const sizeWeight = aircraftSizeWeight(f.aircraft_type); // 0.4 (CRJ) to 1.0 (737)
      const leisureBonus = f.is_leisure_origin ? 1.3 : 1.0;
      const paxScore = (f.estimated_pax || 100) / 100;
      return acc + paxScore * sizeWeight * leisureBonus;
    }, 0),
    4  // cap arrivals contribution at 4
  );

  // 2. Mt. Bachelor — ski season, weekend afternoons only
  if (signals.bachelorOpen && isWeekend(start) && hourBetween(start, 15, 17)) {
    factors.bachelor = signals.freshSnowIn24h > 4 ? 3 : 2;
  }

  // 3. Local events near Bend
  const events = signals.eventsOverlapping(start, end);
  factors.events = Math.min(
    events.reduce((acc, e) => acc + (e.estimated_attendance || 200) / 500, 0),
    2
  );

  // 4. Weather severity — pass closures trap visitors in town
  if (signals.passStatus === 'closed') factors.weather = 2;
  else if (signals.passStatus === 'chains_required') factors.weather = 1;

  // 5. Day-of-week / time-of-day baseline
  factors.timing = baselineDemandScore(start);

  const score = Math.min(
    factors.arrivals + factors.bachelor + factors.events + factors.weather + factors.timing,
    10
  );

  return { score, factors };
}

function baselineDemandScore(t: Date): number {
  const dow = t.getDay(); // 0=Sun
  const hour = t.getHours();
  if ([5, 6].includes(dow) && hour >= 17 && hour < 22) return 1.5; // Fri/Sat evening
  if (dow === 0 && hour >= 10 && hour < 13) return 1.0;             // Sun morning departures
  return 0;
}
```

**Window merging:** After scoring each hour, merge contiguous hours with score ≥ 3 into a single "window" record. Surface top 3 windows per day in the UI.

## API surface (NestJS)

```
GET  /api/v1/windows?from=:isoStart&to=:isoEnd
       → returns scored windows in range, ordered by score desc

GET  /api/v1/today
       → returns top 3 windows for next 24h with factor breakdowns

POST /api/v1/shifts
       body: { started_at, ended_at, gross_earnings_cents, tip_earnings_cents, ride_count, notes }
       → logs shift; backend attaches predicted_score and factors_snapshot

GET  /api/v1/shifts?from=:date&to=:date
       → shift history

GET  /api/v1/accuracy
       → predicted score vs. actual $/hr correlation, by factor

POST /api/v1/notifications/test
       → send a test FCM to confirm wiring

GET  /api/v1/signals/raw?date=:date
       → debug endpoint: dump raw signals for a date (flights, weather, events, bachelor)
```

## Phased roadmap

### Phase 1 — MVP (1–2 weekends)
- NestJS scaffolding, Postgres schema, AWS Lightsail deploy
- FlightAware integration only
- Cron: pull RDM arrivals every 30 min
- Scoring with arrivals + timing baseline only
- Flutter app: Today screen + shift logger
- Basic FCM push (one notification per top window)

### Phase 2 — Multi-signal (1 weekend)
- Add NOAA weather sync
- Add Mt. Bachelor scraper
- Add events scraper (Visit Central Oregon + BendTicket)
- Expand scoring function with all factors

### Phase 3 — History & accuracy (1 weekend)
- History screen with earnings chart
- `/api/v1/accuracy` endpoint — regression: predicted score → actual $/hr
- Per-factor accuracy view

### Phase 4 — Feedback loop (after ≥30 logged shifts)
- Linear regression on factors → $/hr to tune weights
- Replace hand-tuned constants with fitted weights
- Add confidence interval to displayed score

### Phase 5 (future, optional)
- Generalize for other small/medium airports
- Open-source release / shared variant for other Bend XL drivers
- Uber integration (different demand profile; revisit)

## Decisions made

| Decision | Choice | Rationale |
|---|---|---|
| Flight data provider | FlightAware AeroAPI | Free tier sufficient for one airport; cleanest API |
| Hosting | AWS Lightsail container ($10/mo) | Single small instance is enough; familiar |
| ORM | Prisma | Better DX than TypeORM at this scale |
| Auth | Hardcoded single-user JWT v1 | Multi-user is out of scope |
| Mobile platform | Flutter, iOS first | User's existing stack |
| Notifications | FCM | Standard, free, Flutter integration is straightforward |
| Scheduler | `@nestjs/schedule` (no Redis in v1) | Simplest path; add BullMQ only if retries become needed |

## Open questions (defer or ask user)

1. Should the app suggest declining specific ride offers (e.g., low $/mile within a window)? **Probably no** — Lyft handles this via Upfront Pay; user makes the call in-app.
2. Multi-airport later? **Out of scope for v1.**
3. Expense / tax tracking integration? **Out of scope; use existing tools.**

## Reference: manual baseline schedule (sanity check for v0)

The scoring system should reproduce this baseline from real signals within ~2 weeks of operation, then refine:

| Day | Window | Trigger |
|---|---|---|
| Mon–Thu | 10:45 AM – 1:00 PM | RDM mid-day flight bank |
| Fri | 10:45 AM – 1:00 PM | RDM mid-day bank — Friday inbound leisure |
| Fri | 5:00 PM – 8:30 PM | Downtown brewery/restaurant district |
| Sat | 10:45 AM – 1:00 PM | RDM mid-day bank — Saturday inbound leisure |
| Sat (Dec–Mar) | 3:30 PM – 5:30 PM | Mt. Bachelor apré-ski |
| Sat | 6:00 PM – 10:00 PM | Dinner / events / wedding shuttles |
| Sun | 10:00 AM – 12:30 PM | RDM departures bank |

## Out of scope

- Any Lyft API integration (impossible)
- App / driver-app scraping (ToS)
- Multi-driver / fleet features
- Uber integration (v1)
- Trip-by-trip ride filtering (Lyft's in-app XL filter handles this)
- Tax / expense / mileage tracking (separate problem)

## Getting started checklist (for Claude Code)

1. `pnpm create nest-app rdm-driver-forecast`, add Prisma, configure Postgres locally
2. Create the schema in `prisma/schema.prisma` matching the SQL above
3. Stub out `FlightsModule`, `WeatherModule`, `BachelorModule`, `EventsModule`, `ScoringModule`, `ShiftsModule`
4. Implement `FlightsService.syncRdmArrivals()` calling FlightAware AeroAPI `/airports/KRDM/flights/arrivals`
5. Implement `ScoringService.computeWindows()` with the v0 algorithm above
6. Wire `@nestjs/schedule` cron for `*/30 * * * *` (every 30 min) on flights sync, `0 * * * *` (hourly) on scoring recompute
7. Scaffold Flutter app with three screens, connect to local API
8. Deploy backend to Lightsail; point Flutter app at production URL
9. Wire FCM; test notification before first real shift
10. Drive 30 shifts logging every one; revisit weights with regression in Phase 4
