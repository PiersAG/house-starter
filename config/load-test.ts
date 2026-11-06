// The load test every app passes before launch (app-business-core #356; the
// tool is CEO decision #705, so this file names WHAT is run and what passes, and
// any runner reads it).
//
// The requirements it carries, word for word:
//   Matt Murphy #3   "Use tools such as k6 or Artillery to simulate at least 100
//                    concurrent users before launch" — and the test must include
//                    sign-up, because each sign-up makes a database (#356 notes).
//   Matt Murphy #243 "so cores and rate limiting are configured and tested under
//                    a load"
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
  /** Answers that count as working; anything else is an error. */
  ok: number[];
};

export const LOAD_TEST = {
  /** At least 100 at the same time (Matt Murphy #3). */
  concurrentUsers: 100,
  /** Users join over this many seconds, then all stay for `holdSeconds`. */
  rampUpSeconds: 60,
  holdSeconds: 180,
  /**
   * Each virtual user signs up (a NEW account, so a new database each time in
   * per-customer mode), signs in, and then repeats the signed-in steps.
   */
  journey: [
    { name: "home page", method: "GET", path: "/", signedIn: false, ok: [200] },
    { name: "sign up", method: "POST", path: "/api/auth/signup", signedIn: false, ok: [201] },
    { name: "sign in", method: "POST", path: "/api/auth/callback/credentials", signedIn: false, ok: [302] },
    { name: "dashboard", method: "GET", path: "/dashboard", signedIn: true, ok: [200] },
    { name: "settings page", method: "GET", path: "/dashboard/settings", signedIn: true, ok: [200] },
    { name: "health", method: "GET", path: "/api/health", signedIn: false, ok: [200] },
  ] satisfies LoadStep[],
  /**
   * Each virtual user has its own client address, as real users do, so the
   * per-address limits (config/rate-limits.ts) count each user separately. They
   * come from the documentation ranges (RFC 5737), which reach nothing real.
   */
  addressRanges: ["203.0.113.", "198.51.100.", "192.0.2."],
  /** What passes, measured over the whole hold period. */
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
   * while the 100 users above carry on.
   */
  flood: {
    address: "203.0.113.254",
    requestsPerSecond: 50,
    seconds: 20,
    paths: ["/api/auth/signup", "/api/health"],
    expect: { refusedWith: 429, retryAfterHeader: true, maxServerErrors: 0 },
  },
} as const;

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
