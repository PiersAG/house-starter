// Sign-in risk checks and continuous session risk scoring — pure rules, no I/O
// (app-business-core issues 519 and 741; Matt Murphy #89).
//
//   assessSignIn       a sign-in from a device AND a country this account has
//                      never signed in from is "unfamiliar": the account owner is
//                      emailed with a link that signs that device out (#519: "a
//                      'new sign-in' email with revoke link"). A second factor, when
//                      the account has one, was already asked for at sign-in.
//   isImpossibleTravel two readings of one session further apart than a person
//                      could travel in the time between them (#519 "impossible-travel
//                      revocation", #741 "continuous session risk scoring —
//                      impossible travel").
//   scoreSession       a number for how risky this session looks now: impossible
//                      travel, a new country mid-session, a different device
//                      presenting the session, and unusual access volume from the
//                      connection (the escalation's strikes, lib/abuse/route-limit.ts).
//                      At RISK_STEP_UP_AT a sensitive action needs a fresh sign-in;
//                      at RISK_END_AT the session is ended (#741 "auto-challenge or
//                      end session").

import {
  IMPOSSIBLE_TRAVEL_KMH,
  RISK_END_AT,
  RISK_STEP_UP_AT,
  TRAVEL_MIN_KM,
  UNUSUAL_HOURS,
} from "@/config/sessions";

export type GeoReading = { latitude: number | null; longitude: number | null; atMs: number };

/** Great-circle distance in kilometres. */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when going from `prev` to `next` in the time between them is faster than any journey. */
export function isImpossibleTravel(prev: GeoReading, next: GeoReading): boolean {
  if (prev.latitude === null || prev.longitude === null || next.latitude === null || next.longitude === null) {
    return false;
  }
  const km = haversineKm(
    { latitude: prev.latitude, longitude: prev.longitude },
    { latitude: next.latitude, longitude: next.longitude },
  );
  if (km < TRAVEL_MIN_KM) return false;
  const hours = Math.max(next.atMs - prev.atMs, 1) / 3_600_000;
  return km / hours > IMPOSSIBLE_TRAVEL_KMH;
}

export type SignInFamiliarity = "first" | "familiar" | "unfamiliar";

/**
 * How familiar a sign-in looks. "first" = the account has no earlier session
 * (nothing to compare with). "unfamiliar" = neither the device nor the country
 * has been seen on this account before. A sign-in with no country reading (a
 * local run) is never unfamiliar on country grounds alone.
 */
export function assessSignIn(input: {
  hasHistory: boolean;
  knownDevice: boolean;
  knownCountry: boolean;
  country: string | null;
}): SignInFamiliarity {
  if (!input.hasHistory) return "first";
  if (input.knownDevice) return "familiar";
  if (input.country === null || input.knownCountry) return "familiar";
  return "unfamiliar";
}

/** The hour (0–23) at `atMs` in `timezone`, or null when the zone is unknown. */
export function localHour(timezone: string | null, atMs: number): number | null {
  if (!timezone) return null;
  try {
    const h = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: timezone })
      .format(new Date(atMs));
    const n = Number(h);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** True for a local hour in the unusual window (by default midnight to 5 a.m.). */
export function isUnusualHour(hour: number | null): boolean {
  return hour !== null && hour >= UNUSUAL_HOURS.from && hour < UNUSUAL_HOURS.to;
}

export type RiskSignals = {
  impossibleTravel: boolean;
  /** The session is being used from another country than it was last seen in. */
  countryChanged: boolean;
  /** A device id is presented and it is not the one the session started on. */
  otherDevice: boolean;
  /** "suspect" = the connection is throttled by the escalation; "bad" = banned. */
  reputation: "good" | "suspect" | "bad";
};

export const RISK_WEIGHTS = {
  impossibleTravel: RISK_END_AT,
  countryChanged: 30,
  otherDevice: 60,
  suspect: 50,
  bad: RISK_END_AT,
} as const;

export type RiskVerdict = { score: number; action: "none" | "step_up" | "end"; reasons: string[] };

/** The session's risk now, and what it calls for. */
export function scoreSession(s: RiskSignals): RiskVerdict {
  const reasons: string[] = [];
  let score = 0;
  const add = (on: boolean, weight: number, reason: string) => {
    if (!on) return;
    score += weight;
    reasons.push(reason);
  };
  add(s.impossibleTravel, RISK_WEIGHTS.impossibleTravel, "impossible_travel");
  add(s.countryChanged, RISK_WEIGHTS.countryChanged, "country_changed");
  add(s.otherDevice, RISK_WEIGHTS.otherDevice, "other_device");
  add(s.reputation === "suspect", RISK_WEIGHTS.suspect, "unusual_volume");
  add(s.reputation === "bad", RISK_WEIGHTS.bad, "banned_connection");
  const action = score >= RISK_END_AT ? "end" : score >= RISK_STEP_UP_AT ? "step_up" : "none";
  return { score, action, reasons };
}
