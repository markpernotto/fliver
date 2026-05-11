import { prisma } from './db';
import {
  fetchScheduledArrivals,
  normalizeArrival,
  estimateCostCents,
} from './aeroapi';
import { scoreHourlyWindows } from './scoring';

export type SyncResult = {
  arrivalsCount: number;
  pages: number;
  estimatedCostCents: number;
  error?: string;
};

const AIRPORT = 'KRDM';

// Pull a range of /scheduled_arrivals, upsert flights, recompute forecast_windows
// over the range, and log the call. Tier is a free-form label for api_call_log.
export async function syncRange(opts: {
  rangeStart: Date;
  rangeEnd: Date;
  tier: string;
  apiKey: string;
}): Promise<SyncResult> {
  let pages = 0;
  let arrivalsCount = 0;
  let statusCode = 0;
  let errorMessage: string | null = null;

  try {
    const res = await fetchScheduledArrivals({
      airport: AIRPORT,
      rangeStart: opts.rangeStart,
      rangeEnd: opts.rangeEnd,
      apiKey: opts.apiKey,
    });
    pages = res.pages;
    arrivalsCount = res.arrivals.length;
    statusCode = res.rawStatus;

    for (const raw of res.arrivals) {
      const n = normalizeArrival(raw);
      if (!n) continue;
      await prisma.flight.upsert({
        where: { sourceId: n.sourceId },
        create: {
          sourceId: n.sourceId,
          ident: n.ident,
          carrier: n.carrier,
          flightNumber: n.flightNumber,
          scheduledArrival: n.scheduledArrival,
          estimatedArrival: n.estimatedArrival,
          originIata: n.originIata,
          originCity: n.originCity,
          aircraftType: n.aircraftType,
          estimatedPax: n.estimatedPax,
          isLeisureOrigin: n.isLeisureOrigin,
          status: n.status,
        },
        update: {
          estimatedArrival: n.estimatedArrival,
          status: n.status,
          pulledAt: new Date(),
        },
      });
    }
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  await prisma.apiCallLog.create({
    data: {
      provider: 'flightaware',
      endpoint: 'scheduled_arrivals',
      tier: opts.tier,
      statusCode: statusCode || null,
      pages,
      estimatedCostCents: estimateCostCents(pages),
      recordsReturned: arrivalsCount,
      errorMessage,
    },
  });

  if (errorMessage) {
    return { arrivalsCount, pages, estimatedCostCents: estimateCostCents(pages), error: errorMessage };
  }

  await recomputeWindows(opts.rangeStart, opts.rangeEnd);

  return { arrivalsCount, pages, estimatedCostCents: estimateCostCents(pages) };
}

export async function recomputeWindows(start: Date, end: Date) {
  const flights = await prisma.flight.findMany({
    where: {
      OR: [
        { scheduledArrival: { gte: start, lt: end } },
        { estimatedArrival: { gte: start, lt: end } },
      ],
    },
  });
  const hourly = scoreHourlyWindows(start, end, flights);
  for (const h of hourly) {
    await prisma.forecastWindow.upsert({
      where: { windowStart_windowEnd: { windowStart: h.start, windowEnd: h.end } },
      create: {
        windowStart: h.start,
        windowEnd: h.end,
        score: h.score,
        factors: h.factors,
      },
      update: {
        score: h.score,
        factors: h.factors,
        computedAt: new Date(),
      },
    });
  }
}

// Resolve a local-date string like "2026-05-15" to a [start, end) UTC range
// covering that calendar day in the given timezone. Used by /api/refresh
// and /api/forecast for day-grouped queries.
export function dayRangeInTz(dateStr: string, timeZone: string): { start: Date; end: Date } {
  // Parse YYYY-MM-DD as the local-tz midnight, render to UTC.
  // Strategy: build "YYYY-MM-DDT00:00:00" interpreted in timeZone via offset lookup.
  const [y, m, d] = dateStr.split('-').map((s) => parseInt(s, 10));
  if (!y || !m || !d) throw new Error(`Invalid date: ${dateStr}`);
  // Compute the timezone offset at the target wall time using the inverse trick.
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offsetMin = tzOffsetMinutes(new Date(utcGuess), timeZone);
  const start = new Date(utcGuess - offsetMin * 60_000);
  const end = new Date(start.getTime() + 24 * 3600_000);
  return { start, end };
}

function tzOffsetMinutes(d: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour === '24' ? '0' : parts.hour, 10),
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10)
  );
  return (asUtc - d.getTime()) / 60_000;
}
