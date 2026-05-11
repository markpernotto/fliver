import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json();
  const shift = await prisma.shift.create({
    data: {
      startedAt: new Date(body.startedAt),
      endedAt: new Date(body.endedAt),
      grossEarningsCents: body.grossEarningsCents,
      tipEarningsCents: body.tipEarningsCents ?? 0,
      rideCount: body.rideCount,
      startOdometer: body.startOdometer ?? null,
      endOdometer: body.endOdometer ?? null,
      notes: body.notes ?? null,
    },
  });

  // Snapshot the predicted score for the hour the shift started — gives us the
  // outcome variable later for regression.
  const hourStart = new Date(shift.startedAt);
  hourStart.setMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
  const window = await prisma.forecastWindow.findUnique({
    where: { windowStart_windowEnd: { windowStart: hourStart, windowEnd: hourEnd } },
  });
  if (window) {
    await prisma.shift.update({
      where: { id: shift.id },
      data: {
        predictedScore: window.score,
        factorsSnapshot: window.factors as object,
      },
    });
  }

  return NextResponse.json({ id: shift.id }, { status: 201 });
}

export async function GET() {
  const shifts = await prisma.shift.findMany({
    orderBy: { startedAt: 'desc' },
    take: 50,
  });
  return NextResponse.json({ shifts });
}
