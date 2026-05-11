import { NextResponse } from 'next/server';
import { syncRange, dayRangeInTz } from '@/lib/sync';

const TZ = 'America/Los_Angeles';

export const dynamic = 'force-dynamic';

// On-demand refresh for a single day. Called by the app's pull-to-refresh on
// a specific day. Pulls only that 24h window from AeroAPI (~1 page, ~$0.005)
// instead of the full 7-day daily snapshot.
//
// POST /api/refresh?date=YYYY-MM-DD
//   date defaults to today in Pacific time. Auth: Bearer CRON_SECRET.
export async function POST(req: Request) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.AEROAPI_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'AEROAPI_KEY not configured' }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const dateStr = searchParams.get('date') ?? todayInTz(TZ);

  let range: { start: Date; end: Date };
  try {
    range = dayRangeInTz(dateStr, TZ);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }

  // If the requested day is entirely in the past, refuse — there's nothing
  // useful AeroAPI will return for it.
  if (range.end < new Date()) {
    return NextResponse.json({ error: 'date is in the past' }, { status: 400 });
  }

  const result = await syncRange({
    rangeStart: range.start,
    rangeEnd: range.end,
    tier: 'on-demand-day',
    apiKey,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({
    date: dateStr,
    arrivalsCount: result.arrivalsCount,
    pages: result.pages,
    estimatedCostCents: result.estimatedCostCents,
  });
}

function todayInTz(timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA returns YYYY-MM-DD format directly
  return fmt.format(new Date());
}
