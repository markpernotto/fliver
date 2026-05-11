import { PrismaClient } from '@prisma/client';
import { estimatedPax, isLeisureOrigin } from '../lib/aircraft';

const prisma = new PrismaClient();

type Sample = {
  hoursFromNow: number;
  carrier: string;
  flightNumber: string;
  origin: string;
  aircraft: string;
};

const CITY: Record<string, string> = {
  SEA: 'Seattle',
  SLC: 'Salt Lake City',
  DEN: 'Denver',
  PHX: 'Phoenix',
  LAX: 'Los Angeles',
  PDX: 'Portland',
  SFO: 'San Francisco',
  LAS: 'Las Vegas',
  DFW: 'Dallas/Fort Worth',
};

const SAMPLES: Sample[] = [
  // Mid-day flight bank ~4-6 hours from now
  { hoursFromNow: 4.0, carrier: 'AS', flightNumber: '2243', origin: 'SEA', aircraft: 'B739' },
  { hoursFromNow: 4.5, carrier: 'DL', flightNumber: '4321', origin: 'SLC', aircraft: 'CRJ9' },
  { hoursFromNow: 5.0, carrier: 'UA', flightNumber: '5612', origin: 'DEN', aircraft: 'E175' },
  { hoursFromNow: 5.25, carrier: 'AA', flightNumber: '2987', origin: 'PHX', aircraft: 'CRJ9' },
  { hoursFromNow: 5.75, carrier: 'AS', flightNumber: '2155', origin: 'LAX', aircraft: 'B738' },
  // Afternoon
  { hoursFromNow: 9.0, carrier: 'AS', flightNumber: '2189', origin: 'PDX', aircraft: 'E175' },
  { hoursFromNow: 11.0, carrier: 'UA', flightNumber: '5777', origin: 'SFO', aircraft: 'CRJ7' },
  // Evening
  { hoursFromNow: 14.0, carrier: 'AS', flightNumber: '2244', origin: 'SEA', aircraft: 'B738' },
  // Tomorrow's mid-day bank
  { hoursFromNow: 28.0, carrier: 'AS', flightNumber: '2243', origin: 'SEA', aircraft: 'B739' },
  { hoursFromNow: 28.5, carrier: 'DL', flightNumber: '4322', origin: 'SLC', aircraft: 'CRJ9' },
];

async function main() {
  await prisma.flight.deleteMany({ where: { sourceId: { startsWith: 'seed-' } } });

  const now = new Date();
  for (const s of SAMPLES) {
    const sched = new Date(now.getTime() + s.hoursFromNow * 3600_000);
    await prisma.flight.create({
      data: {
        sourceId: `seed-${s.carrier}${s.flightNumber}-${sched.toISOString()}`,
        ident: `${s.carrier}${s.flightNumber}`,
        carrier: s.carrier,
        flightNumber: s.flightNumber,
        scheduledArrival: sched,
        estimatedArrival: sched,
        originIata: s.origin,
        originCity: CITY[s.origin] ?? s.origin,
        aircraftType: s.aircraft,
        estimatedPax: estimatedPax(s.aircraft),
        isLeisureOrigin: isLeisureOrigin(s.origin, sched),
        status: 'Scheduled',
      },
    });
  }

  console.log(`Seeded ${SAMPLES.length} synthetic KRDM arrivals.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
