import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { syncRange } from '@/lib/sync';

const OP_HOUR_START_LOCAL = 6;
const OP_HOUR_END_LOCAL = 22;
const TZ = 'America/Los_Angeles';

// Daily snapshot pulls 7 days forward. AeroAPI v4 /scheduled_arrivals accepts
// a multi-day range; 7d is enough for weekend planning and keeps cost under ~$3/mo.
const DAILY_HORIZON_HOURS = 168;
const HOURLY_HORIZON_HOURS = 3;
// Drop flights this old after each daily sync (6h grace for "just landed" UX).
const FLIGHT_RETENTION_HOURS = 6;

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') ?? 'hourly';

  const apiKey = process.env.AEROAPI_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'AEROAPI_KEY not configured' }, { status: 500 });
  }

  // Skip the hourly tier outside RDM operating hours — saves AeroAPI credit.
  if (type === 'hourly') {
    const localHour = hourInTz(new Date(), TZ);
    if (localHour < OP_HOUR_START_LOCAL || localHour >= OP_HOUR_END_LOCAL) {
      return NextResponse.json({ skipped: 'outside operating hours', localHour });
    }
  }

  const now = new Date();
  const horizonHours = type === 'daily' ? DAILY_HORIZON_HOURS : HOURLY_HORIZON_HOURS;
  const rangeEnd = new Date(now.getTime() + horizonHours * 3600_000);

  const result = await syncRange({
    rangeStart: now,
    rangeEnd,
    tier: type === 'daily' ? 'daily-snapshot' : 'status-refresh',
    apiKey,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  let pruned = 0;
  if (type === 'daily') {
    const cutoff = new Date(now.getTime() - FLIGHT_RETENTION_HOURS * 3600_000);
    const r = await prisma.flight.deleteMany({
      where: {
        AND: [
          { scheduledArrival: { lt: cutoff } },
          {
            OR: [
              { estimatedArrival: null },
              { estimatedArrival: { lt: cutoff } },
            ],
          },
        ],
      },
    });
    pruned = r.count;
  }

  return NextResponse.json({
    type,
    arrivalsCount: result.arrivalsCount,
    pages: result.pages,
    estimatedCostCents: result.estimatedCostCents,
    prunedFlights: pruned,
  });
}

function hourInTz(d: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  });
  const raw = parseInt(fmt.format(d), 10);
  return raw === 24 ? 0 : raw;
}
