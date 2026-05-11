// Aircraft type → estimated passenger count. Codes follow ICAO 4-letter type designators
// (which is what AeroAPI returns in `aircraft_type`).
//
// Values are typical-config approximations for the common RDM fleet — full to capacity
// is not what we want; we want a realistic max-pax-on-this-flight estimate.
export const AIRCRAFT_PAX: Record<string, number> = {
  // Boeing
  B737: 143,
  B738: 160,
  B739: 175,
  // Airbus
  A319: 128,
  A320: 150,
  A321: 190,
  // Embraer
  E170: 70,
  E175: 76,
  E190: 100,
  // Bombardier / regional jets
  CRJ2: 50,
  CRJ7: 70,
  CRJ9: 76,
  // Turboprops (rare at RDM but possible)
  DH8D: 76,
  AT72: 70,
};

export function estimatedPax(aircraftType: string | null | undefined): number {
  if (!aircraftType) return 100;
  return AIRCRAFT_PAX[aircraftType] ?? 100;
}

// 0.4 (tiny RJ) to 1.0 (mainline narrowbody). Used as a multiplier in scoring so that
// a CRJ7 doesn't get treated like a 737 just because the pax count is close-ish.
export function aircraftSizeWeight(aircraftType: string | null | undefined): number {
  const pax = estimatedPax(aircraftType);
  if (pax >= 150) return 1.0;
  if (pax >= 100) return 0.75;
  if (pax >= 70) return 0.55;
  return 0.4;
}

// IATA origin codes that bring leisure travelers to Bend year-round.
// Leisure travelers = more likely to take XL (groups/families with luggage).
const LEISURE_ALWAYS = new Set(['LAS', 'PHX', 'LAX', 'SFO', 'SAN', 'BUR', 'DFW']);

// Ski-season-only leisure origins (Dec, Jan, Feb, Mar).
const LEISURE_SKI_SEASON = new Set(['DEN', 'SLC']);

export function isLeisureOrigin(iata: string, when: Date = new Date()): boolean {
  if (LEISURE_ALWAYS.has(iata)) return true;
  // Pacific month — RDM ski-season demand is anchored to local calendar, not UTC.
  const monthOneIndexed = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'numeric',
    }).format(when),
    10
  );
  const month = monthOneIndexed - 1;
  const inSkiSeason = month <= 2 || month === 11;
  if (inSkiSeason && LEISURE_SKI_SEASON.has(iata)) return true;
  return false;
}
