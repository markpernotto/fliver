import { estimatedPax, isLeisureOrigin } from './aircraft';

const AEROAPI_BASE = 'https://aeroapi.flightaware.com/aeroapi';
const PAGE_SIZE = 15; // AeroAPI result-set size; used as a fallback when num_pages is absent

export type AeroApiArrival = {
  fa_flight_id: string;
  ident?: string;
  ident_iata?: string;
  operator?: string;
  operator_iata?: string;
  flight_number?: string;
  scheduled_in: string;
  estimated_in?: string;
  actual_in?: string;
  origin: {
    code?: string;
    code_iata?: string;
    code_icao?: string;
    city?: string;
  };
  aircraft_type?: string;
  status?: string;
  cancelled?: boolean;
};

type AeroApiArrivalsResponse = {
  scheduled_arrivals: AeroApiArrival[];
  links?: { next?: string };
  num_pages?: number;
};

export type NormalizedArrival = {
  sourceId: string;
  ident: string | null;
  carrier: string | null;
  flightNumber: string | null;
  scheduledArrival: Date;
  estimatedArrival: Date | null;
  originIata: string;
  originCity: string | null;
  aircraftType: string | null;
  estimatedPax: number;
  isLeisureOrigin: boolean;
  status: string | null;
};

export type FetchResult = {
  arrivals: AeroApiArrival[];
  pages: number;
  rawStatus: number;
};

export async function fetchScheduledArrivals(opts: {
  airport: string;
  rangeStart: Date;
  rangeEnd: Date;
  apiKey: string;
}): Promise<FetchResult> {
  const url = new URL(`${AEROAPI_BASE}/airports/${opts.airport}/flights/scheduled_arrivals`);
  url.searchParams.set('start', formatAeroApiTime(opts.rangeStart));
  url.searchParams.set('end', formatAeroApiTime(opts.rangeEnd));
  url.searchParams.set('max_pages', '5'); // hard ceiling — KRDM never approaches this

  const r = await fetch(url.toString(), { headers: { 'x-apikey': opts.apiKey } });
  if (!r.ok) {
    throw new Error(`AeroAPI ${r.status}: ${await r.text()}`);
  }

  const data = (await r.json()) as AeroApiArrivalsResponse;
  const arrivals = data.scheduled_arrivals ?? [];
  const pages = data.num_pages ?? Math.max(1, Math.ceil(arrivals.length / PAGE_SIZE));

  return { arrivals, pages, rawStatus: r.status };
}

// AeroAPI v4 only accepts second-precision ISO 8601 ("2026-05-11T23:07:27Z").
// `Date.toISOString()` adds milliseconds; stripping them avoids a 400.
function formatAeroApiTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function normalizeArrival(a: AeroApiArrival): NormalizedArrival | null {
  const originIata = a.origin?.code_iata ?? a.origin?.code ?? null;
  if (!originIata) return null;
  const sched = new Date(a.scheduled_in);
  return {
    sourceId: a.fa_flight_id,
    ident: a.ident_iata ?? a.ident ?? null,
    carrier: a.operator_iata ?? a.operator ?? null,
    flightNumber: a.flight_number ?? null,
    scheduledArrival: sched,
    estimatedArrival: a.estimated_in ? new Date(a.estimated_in) : null,
    originIata,
    originCity: a.origin?.city ?? null,
    aircraftType: a.aircraft_type ?? null,
    estimatedPax: estimatedPax(a.aircraft_type),
    isLeisureOrigin: isLeisureOrigin(originIata, sched),
    status: a.cancelled ? 'Cancelled' : a.status ?? null,
  };
}

// AeroAPI v4: /scheduled_arrivals is $0.005 per result set (15 records).
// Returns cents (with decimals — Decimal column in DB).
export function estimateCostCents(pages: number): number {
  return pages * 0.5;
}
