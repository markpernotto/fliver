import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  scoreHourlyWindows,
  mergeIntoWindows,
  type Factors,
  type ScoredWindow,
} from '@/lib/scoring';

export const dynamic = 'force-dynamic';

export async function GET() {
  const now = new Date();
  const end = new Date(now.getTime() + 24 * 3600_000);

  // Prefer pre-computed forecast_windows if they cover the range. Otherwise compute
  // on the fly from flights — useful in dev (seed only, no cron has run).
  const persisted = await prisma.forecastWindow.findMany({
    where: { windowStart: { gte: now, lt: end } },
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
      : await computeOnTheFly(now, end);

  const merged = mergeIntoWindows(hourly, 3).sort(
    (a, b) => b.score - a.score || a.start.getTime() - b.start.getTime()
  );

  return NextResponse.json({
    generatedAt: now.toISOString(),
    source: persisted.length > 0 ? 'persisted' : 'computed',
    topWindows: merged.slice(0, 3).map(serialize),
    allWindows: merged.map(serialize),
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
