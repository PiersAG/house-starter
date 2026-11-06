// The load test every app passes before launch (app-business-core #356; the tool
// is k6, CEO ruling on #705). This file names WHAT is run and what passes;
// scripts/load/journey.js is the k6 script that reads it, and scripts/load/gate.ts
// judges the result.
//
// The requirements it carries, word for word:
//   Matt Murphy #3   "Use tools such as k6 or Artillery to simulate at least 100
//                    concurrent users before launch" — and the test must include
//                    sign-up, because each sign-up makes a database (#356 notes).
//   Matt Murphy #243 "so cores and rate limiting are configured and tested under
//                    a load" ("cores" is the transcript's mis-hearing of CORS)
//   Matt Murphy #326 "load testing before launch not we'll see what happens but
//                    actual simulated traffic"
//
// WHERE IT RUNS: a locally built copy of the app, or the proof app the factory
// builds fresh from this template — never a live customer app, never a paid
// load-testing service (CEO brief, Dispatch AN; "free tiers first"). The runner
// checks its target with assertLoadTarget below before sending anything.

/** One step of a virtual user's visit, in order. */
export type LoadStep = {
  name: string;
  method: "GET" | "POST";
  path: string;
  /** Signed-in steps carry the session the sign-in step made. */
  signedIn: boolean;
  /** Repeated for as long as the run lasts; the others happen once per user. */
  repeats: boolean;
  /** Answers that count as working; anything else is an error. */
  ok: number[];
};

export const LOAD_TEST = {
  /** At least 100 at the same time (Matt Murphy #3). */
  concurrentUsers: 100,
  /** Users join over this many seconds, then all stay for `holdSeconds`. */
  rampUpSeconds: 60,
  holdSeconds: 180,
  /** A person pauses between clicks; a virtual user waits this long, at random. */
  thinkSeconds: [1, 3],
  /**
   * Each virtual user signs up (a NEW account, so a new database each time in
   * per-customer mode), signs in, and then repeats the signed-in steps.
   */
  journey: [
    { name: "home page", method: "GET", path: "/", signedIn: false, repeats: false, ok: [200] },
    { name: "sign up", method: "POST", path: "/api/auth/signup", signedIn: false, repeats: false, ok: [201] },
    { name: "sign-in form", method: "GET", path: "/api/auth/csrf", signedIn: false, repeats: false, ok: [200] },
    { name: "sign in", method: "POST", path: "/api/auth/callback/credentials", signedIn: false, repeats: false, ok: [302] },
    { name: "dashboard", method: "GET", path: "/dashboard", signedIn: true, repeats: true, ok: [200] },
    { name: "settings page", method: "GET", path: "/dashboard/settings", signedIn: true, repeats: true, ok: [200] },
    { name: "health", method: "GET", path: "/api/health", signedIn: false, repeats: true, ok: [200] },
  ] satisfies LoadStep[],
  /** The 100 sign up during the ramp; these keep sign-ups coming at full load. */
  newSignUpEverySeconds: 2,
  /**
   * Each virtual user has its own client address, as real users do, so the
   * per-address limits (config/rate-limits.ts) count each user separately. They
   * come from the documentation ranges (RFC 5737), which reach nothing real.
   */
  addressRanges: ["203.0.113.", "198.51.100.", "192.0.2."],
  /** What passes, measured over the whole run, so sign-up counts too. */
  pass: {
    /** Share of journey requests answered with something outside `ok`. */
    maxErrorRate: 0.01,
    /** 95% of requests answered within this. */
    p95Milliseconds: 1500,
    /** No server error at all: a 5xx under load is the bug this test is for. */
    maxServerErrors: 0,
  },
  /**
   * Rate limiting under load (Matt Murphy #243): one address floods sign-up and
   * the health check; the limits must answer 429 with Retry-After, never a 5xx,
   * while the 100 users above carry on. The rate is per path, and high enough to
   * pass the health limit even at the test environment's tenfold limits (600 a
   * minute; config/rate-limits.ts, SAFE_TEST_FACTOR).
   */
  flood: {
    address: "203.0.113.254",
    startAfterRampSeconds: 60,
    requestsPerSecondPerPath: 50,
    seconds: 20,
    paths: ["/api/auth/signup", "/api/health"],
    expect: {
      refusedWith: 429,
      retryAfterHeader: true,
      maxServerErrors: 0,
      /** What a flood request may get before its limit is reached. */
      beforeTheLimit: [200, 400],
    },
  },
  /**
   * CORS under load (Matt Murphy #243), during the flood: another website's write
   * and its preflight must stay refused with no CORS header (lib/cors.ts, lib/csrf.ts).
   */
  cors: {
    address: "203.0.113.253",
    foreignOrigin: "https://another-site.example",
    writePath: "/api/auth/signup",
    requestsPerSecond: 2,
    refusedWith: 403,
  },
} as const;

/** A step's or path's name, as a k6 metric name allows it. */
export function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** The machine itself: the only place a load test is sent. */
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** Refuse any target that is not a locally served copy of the app. */
export function assertLoadTarget(base: string): URL {
  const url = new URL(base);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `The load test runs against a locally served copy of the app or the proof app only (http://127.0.0.1 or http://localhost), never ${base}.`,
    );
  }
  return url;
}

/** The client address virtual user `n` (0-based) sends. */
export function userAddress(n: number): string {
  const ranges = LOAD_TEST.addressRanges;
  const perRange = 250;
  if (n < 0 || n >= ranges.length * perRange) throw new Error(`no documentation address for user ${n}`);
  return `${ranges[Math.floor(n / perRange)]}${(n % perRange) + 1}`;
}
