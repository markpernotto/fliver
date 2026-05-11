import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  mergeIntoWindows,
  scoreHourlyWindows,
  type Factors,
  type ScoredWindow,
} from '@/lib/scoring';
import { dayRangeInTz } from '@/lib/sync';

const TZ = 'America/Los_Angeles';

export const dynamic = 'force-dynamic';

// Multi-day forecast view. Returns scored windows grouped by local calendar day.
//
// GET /api/forecast?days=7         → next 7 days (default)
// GET /api/forecast?days=10
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = clamp(parseInt(searchParams.get('days') ?? '7', 10), 1, 10);

  const now = new Date();
  const todayStr = todayInTz(TZ);
  const startOfToday = dayRangeInTz(todayStr, TZ).start;
  const rangeEnd = new Date(startOfToday.getTime() + days * 24 * 3600_000);

  const persisted = await prisma.forecastWindow.findMany({
    where: { windowStart: { gte: startOfToday, lt: rangeEnd } },
    orderBy: { windowStart: 'asc' },
  });

  const hourly: ScoredWindow[] =
    persisted.length > 0
      ? persisted.map((w) => ({
          start: w.windowStart,
          end: w.windowEnd,
          score: Number(w.score),
          factors: w.factors as unknown as Factors,
        }))
      : await computeOnTheFly(startOfToday, rangeEnd);

  // Group by local calendar date, then merge contiguous high-scoring hours within
  // each day. Don't merge across midnight — that's never a useful display.
  const byDay = new Map<string, ScoredWindow[]>();
  for (const w of hourly) {
    const key = dayKey(w.start, TZ);
    const list = byDay.get(key) ?? [];
    list.push(w);
    byDay.set(key, list);
  }

  const result = [];
  for (let i = 0; i < days; i++) {
    const dayStart = new Date(startOfToday.getTime() + i * 24 * 3600_000);
    const dayStr = dayKey(dayStart, TZ);
    const hours = (byDay.get(dayStr) ?? []).sort(
      (a, b) => a.start.getTime() - b.start.getTime()
    );
    const merged = mergeIntoWindows(hours, 3).sort((a, b) => b.score - a.score);
    result.push({
      date: dayStr,
      dayOfWeek: dayOfWeek(dayStart, TZ),
      topWindows: merged.slice(0, 3).map(serialize),
      allWindows: merged.map(serialize),
    });
  }

  return NextResponse.json({
    generatedAt: now.toISOString(),
    source: persisted.length > 0 ? 'persisted' : 'computed',
    days: result,
  });
}

async function computeOnTheFly(start: Date, end: Date): Promise<ScoredWindow[]> {
  const flights = await prisma.flight.findMany({
    where: {
      OR: [
        { scheduledArrival: { gte: start, lt: end } },
        { estimatedArrival: { gte: start, lt: end } },
      ],
    },
  });
  return scoreHourlyWindows(start, end, flights);
}

function serialize(w: ScoredWindow) {
  return {
    start: w.start.toISOString(),
    end: w.end.toISOString(),
    score: Number(w.score.toFixed(2)),
    factors: w.factors,
  };
}

function dayKey(d: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

function dayOfWeek(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(d);
}

function todayInTz(timeZone: string): string {
  return dayKey(new Date(), timeZone);
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
