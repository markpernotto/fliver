import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json();
  const ride = await prisma.ride.create({
    data: {
      shiftId: body.shiftId ?? null,
      startedAt: new Date(body.startedAt),
      endedAt: new Date(body.endedAt),
      grossCents: body.grossCents,
      tipCents: body.tipCents ?? 0,
      miles: body.miles ?? null,
      pickupZone: body.pickupZone ?? null,
      dropoffZone: body.dropoffZone ?? null,
      productType: body.productType ?? 'XL',
      notes: body.notes ?? null,
    },
  });
  return NextResponse.json({ id: ride.id }, { status: 201 });
}

export async function GET() {
  const rides = await prisma.ride.findMany({
    orderBy: { startedAt: 'desc' },
    take: 200,
  });
  return NextResponse.json({ rides });
}
