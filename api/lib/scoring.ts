import type { Flight } from '@prisma/client';
import { aircraftSizeWeight } from './aircraft';

export type Factors = {
  arrivals: number;
  bachelor: number;
  events: number;
  weather: number;
  timing: number;
};

export type ScoredWindow = {
  start: Date;
  end: Date;
  score: number;
  factors: Factors;
};

// Score every hour in [rangeStart, rangeEnd). Hour-aligned to local clock.
export function scoreHourlyWindows(
  rangeStart: Date,
  rangeEnd: Date,
  flights: Flight[]
): ScoredWindow[] {
  const windows: ScoredWindow[] = [];
  const cur = new Date(rangeStart);
  cur.setMinutes(0, 0, 0);
  while (cur < rangeEnd) {
    const hourStart = new Date(cur);
    const hourEnd = new Date(cur.getTime() + 60 * 60 * 1000);
    windows.push(scoreHour(hourStart, hourEnd, flights));
    cur.setHours(cur.getHours() + 1);
  }
  return windows;
}

function scoreHour(start: Date, end: Date, allFlights: Flight[]): ScoredWindow {
  const factors: Factors = {
    arrivals: 0,
    bachelor: 0,
    events: 0,
    weather: 0,
    timing: 0,
  };

  // 1. Airport arrivals — passenger-weighted, leisure-boosted. Include flights
  // arriving up to 30 min before the window opens (a ride request can hit before
  // the flight lands).
  const lookback = new Date(start.getTime() - 30 * 60 * 1000);
  const relevant = allFlights.filter((f) => {
    const t = f.estimatedArrival ?? f.scheduledArrival;
    return t >= lookback && t < end;
  });
  factors.arrivals = Math.min(
    relevant.reduce((acc, f) => {
      const sizeW = aircraftSizeWeight(f.aircraftType);
      const leisureBonus = f.isLeisureOrigin ? 1.3 : 1.0;
      const paxScore = (f.estimatedPax ?? 100) / 100;
      return acc + paxScore * sizeW * leisureBonus;
    }, 0),
    4
  );

  // 2-4. Bachelor / events / weather — Phase 5 hooks
  factors.bachelor = 0;
  factors.events = 0;
  factors.weather = 0;

  // 5. Day-of-week / time-of-day baseline encodes the manual baseline schedule
  factors.timing = baselineDemandScore(start);

  const total = Math.min(
    factors.arrivals + factors.bachelor + factors.events + factors.weather + factors.timing,
    10
  );

  return { start, end, score: total, factors };
}

const SCORING_TZ = 'America/Los_Angeles';

type PacificCalendar = { hour: number; dow: number; month: number };

function inPacific(t: Date): PacificCalendar {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: SCORING_TZ,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
    month: 'numeric',
  });
  const parts = fmt.formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hourRaw = parseInt(get('hour'), 10);
  const month = parseInt(get('month'), 10);
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    hour: hourRaw === 24 ? 0 : hourRaw,
    dow: dowMap[get('weekday')] ?? 0,
    month: month - 1,
  };
}

// Encodes the manual baseline from the original plan (mid-day bank, Fri/Sat evening,
// Sun morning departures, Sat winter apré-ski). Pacific clock — RDM operates in PT.
// When data arrives, the regression step will reweight these.
function baselineDemandScore(t: Date): number {
  const { hour, dow, month } = inPacific(t);

  // Mid-day flight bank Mon–Sat
  if (dow >= 1 && dow <= 6 && hour >= 10 && hour < 13) return 1.5;

  // Sunday morning departures
  if (dow === 0 && hour >= 10 && hour < 13) return 1.0;

  // Fri/Sat evening brewery/dinner
  if ((dow === 5 || dow === 6) && hour >= 17 && hour < 22) return 1.5;

  // Sat winter apré-ski (Dec–Mar)
  const inSkiSeason = month <= 2 || month === 11;
  if (dow === 6 && hour >= 15 && hour < 18 && inSkiSeason) return 1.0;

  return 0;
}

// Merge contiguous hours with score >= threshold into one window; score becomes
// the max of the constituent hours, factors are element-wise max.
export function mergeIntoWindows(hourly: ScoredWindow[], threshold = 3): ScoredWindow[] {
  const merged: ScoredWindow[] = [];
  let current: ScoredWindow | null = null;
  for (const h of hourly) {
    if (h.score >= threshold) {
      if (current && current.end.getTime() === h.start.getTime()) {
        current = {
          start: current.start,
          end: h.end,
          score: Math.max(current.score, h.score),
          factors: maxFactors(current.factors, h.factors),
        };
      } else {
        if (current) merged.push(current);
        current = h;
      }
    } else {
      if (current) merged.push(current);
      current = null;
    }
  }
  if (current) merged.push(current);
  return merged;
}

function maxFactors(a: Factors, b: Factors): Factors {
  return {
    arrivals: Math.max(a.arrivals, b.arrivals),
    bachelor: Math.max(a.bachelor, b.bachelor),
    events: Math.max(a.events, b.events),
    weather: Math.max(a.weather, b.weather),
    timing: Math.max(a.timing, b.timing),
  };
}
