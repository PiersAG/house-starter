// The load test itself (app-business-core #356; tool: k6, CEO ruling on #705).
//
//   k6 run -e BASE_URL=http://127.0.0.1:3100 -e OUT_DIR=load-results scripts/load/journey.js
//
// Run it through scripts/load/run.sh, which serves the built app on this machine,
// checks the target and gates the result. What it sends and what passes is in
// config/load-test.ts; this file only turns that plan into k6 scenarios. Four run at
// once:
//   users      100 virtual users: sign up, sign in, then keep using the app
//   newcomers  fresh sign-ups through the hold, so a database is made under full load
//   flood      one address hammers sign-up and the health check (the rate limits)
//   cors       another website's requests, which must stay refused under load
//
// k6 runs this in its own JavaScript runtime, not Node: no process, no URL class.

import http from "k6/http";
import exec from "k6/execution";
import { sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { LOAD_TEST as PLAN, slug, userAddress } from "../../config/load-test.ts";

const BASE = __ENV.BASE_URL;
const OUT = __ENV.OUT_DIR || "load-results";
// The second lock on the target; run.sh has already run assertLoadTarget.
if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(BASE || "")) {
  throw new Error(`The load test runs against a locally served copy only, never ${BASE}.`);
}

const RUN = String(Date.now());
const JSON_HEADERS = { "content-type": "application/json" };
const NEWCOMER_ADDRESS_START = 400;

const journeyErrors = new Rate("journey_errors");
const journeyDuration = new Trend("journey_duration", true);
const journeyServerErrors = new Counter("journey_server_errors");
const signedUp = new Counter("users_signed_up");
const signedIn = new Counter("users_signed_in");
const newcomersSignedUp = new Counter("newcomers_signed_up");
const floodRequests = new Counter("flood_requests");
const floodServerErrors = new Counter("flood_server_errors");
const floodNoRetryAfter = new Counter("flood_refused_without_retry_after");
const floodUnexpected = new Counter("flood_unexpected_answers");
const corsRequests = new Counter("cors_requests");
const corsFailures = new Counter("cors_failures");
const stepTrends = Object.fromEntries(PLAN.journey.map((s) => [s.name, new Trend(`step_${slug(s.name)}`, true)]));
const floodRefused = Object.fromEntries(PLAN.flood.paths.map((p) => [p, new Counter(`flood_refused_${slug(p)}`)]));

const floodStart = PLAN.rampUpSeconds + PLAN.flood.startAfterRampSeconds;

export const options = {
  discardResponseBodies: true,
  // A virtual user stays signed in between passes of the journey.
  noCookiesReset: true,
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max", "count"],
  scenarios: {
    users: {
      executor: "ramping-vus",
      exec: "user",
      startVUs: 0,
      stages: [
        { duration: `${PLAN.rampUpSeconds}s`, target: PLAN.concurrentUsers },
        { duration: `${PLAN.holdSeconds}s`, target: PLAN.concurrentUsers },
      ],
      gracefulRampDown: "0s",
      gracefulStop: "15s",
    },
    newcomers: {
      executor: "constant-arrival-rate",
      exec: "newcomer",
      startTime: `${PLAN.rampUpSeconds}s`,
      duration: `${PLAN.holdSeconds}s`,
      rate: 1,
      timeUnit: `${PLAN.newSignUpEverySeconds}s`,
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
    flood: {
      executor: "constant-arrival-rate",
      exec: "flood",
      startTime: `${floodStart}s`,
      duration: `${PLAN.flood.seconds}s`,
      rate: PLAN.flood.requestsPerSecondPerPath * PLAN.flood.paths.length,
      timeUnit: "1s",
      preAllocatedVUs: 40,
      maxVUs: 120,
    },
    cors: {
      executor: "constant-arrival-rate",
      exec: "cors",
      startTime: `${floodStart}s`,
      duration: `${PLAN.flood.seconds}s`,
      rate: PLAN.cors.requestsPerSecond,
      timeUnit: "1s",
      preAllocatedVUs: 4,
      maxVUs: 20,
    },
  },
};

/** One journey request, measured and judged against the plan's `ok` list. */
function step(name, send) {
  const planned = PLAN.journey.find((s) => s.name === name);
  const res = send(planned);
  const ok = planned.ok.includes(res.status);
  journeyErrors.add(!ok);
  journeyDuration.add(res.timings.duration);
  stepTrends[name].add(res.timings.duration);
  // Status 0 is no answer at all (refused, reset or timed out): worse than a 5xx.
  if (res.status >= 500 || res.status === 0) journeyServerErrors.add(1);
  if (!ok) console.warn(`${name}: answered ${res.status} (${res.error || "no transport error"})`);
  return ok;
}

const params = (planned, headers) => ({ headers, redirects: 0, tags: { name: planned.name } });

function signUp(email, password, address) {
  return step("sign up", (p) =>
    http.post(`${BASE}${p.path}`, JSON.stringify({ email, password }), params(p, { ...JSON_HEADERS, "x-forwarded-for": address })),
  );
}

function think() {
  const [low, high] = PLAN.thinkSeconds;
  sleep(low + Math.random() * (high - low));
}

/** Sign in as a browser does: the form's token, then the form. */
function signIn(email, password, address) {
  const headers = { "x-forwarded-for": address };
  let token = "";
  const gotToken = step("sign-in form", (p) => {
    const res = http.get(`${BASE}${p.path}`, { ...params(p, headers), responseType: "text" });
    try {
      token = res.json("csrfToken") || "";
    } catch {
      token = "";
    }
    return res;
  });
  if (!gotToken) return false;
  return step("sign in", (p) =>
    http.post(`${BASE}${p.path}`, { csrfToken: token, email, password, callbackUrl: "/dashboard" }, params(p, headers)),
  );
}

export function user() {
  const vu = exec.vu.idInTest;
  const address = userAddress(vu - 1);
  const headers = { "x-forwarded-for": address };
  // A virtual user's first pass is the new customer's: home page, sign up, sign in.
  if (exec.vu.iterationInScenario === 0) {
    const email = `load-${RUN}-${vu}@example.invalid`;
    const password = `load test throwaway passphrase ${RUN}`;
    step("home page", (p) => http.get(`${BASE}${p.path}`, params(p, headers)));
    think();
    if (!signUp(email, password, address)) return;
    signedUp.add(1);
    if (!signIn(email, password, address)) return;
    signedIn.add(1);
  }
  // After that, the signed-in steps, for as long as the run lasts. The session
  // cookie stays in this virtual user's own jar.
  for (const planned of PLAN.journey.filter((s) => s.repeats)) {
    step(planned.name, (p) => http.get(`${BASE}${p.path}`, params(p, headers)));
    think();
  }
}

export function newcomer() {
  const n = exec.scenario.iterationInTest;
  const email = `load-${RUN}-new-${n}@example.invalid`;
  const password = `load test throwaway passphrase ${RUN}`;
  if (signUp(email, password, userAddress(NEWCOMER_ADDRESS_START + n))) newcomersSignedUp.add(1);
}

export function flood() {
  const paths = PLAN.flood.paths;
  const path = paths[exec.scenario.iterationInTest % paths.length];
  const headers = { "x-forwarded-for": PLAN.flood.address };
  const tags = { name: `flood ${path}` };
  const res = path.startsWith("/api/auth/")
    ? http.post(`${BASE}${path}`, "{}", { headers: { ...JSON_HEADERS, ...headers }, redirects: 0, tags })
    : http.get(`${BASE}${path}`, { headers, redirects: 0, tags });
  floodRequests.add(1);
  if (res.status >= 500 || res.status === 0) floodServerErrors.add(1);
  else if (res.status === PLAN.flood.expect.refusedWith) {
    floodRefused[path].add(1);
    if (!res.headers["Retry-After"]) floodNoRetryAfter.add(1);
  } else if (!PLAN.flood.expect.beforeTheLimit.includes(res.status)) floodUnexpected.add(1);
}

export function cors() {
  const headers = { origin: PLAN.cors.foreignOrigin, "x-forwarded-for": PLAN.cors.address };
  const write = http.post(`${BASE}${PLAN.cors.writePath}`, "{}", {
    headers: { ...JSON_HEADERS, ...headers },
    redirects: 0,
    tags: { name: "cors write" },
  });
  const preflight = http.request("OPTIONS", `${BASE}${PLAN.cors.writePath}`, null, {
    headers: { ...headers, "access-control-request-method": "POST" },
    redirects: 0,
    tags: { name: "cors preflight" },
  });
  for (const res of [write, preflight]) {
    corsRequests.add(1);
    if (res.status !== PLAN.cors.refusedWith || res.headers["Access-Control-Allow-Origin"]) corsFailures.add(1);
  }
}

export function handleSummary(data) {
  return { [`${OUT}/summary.json`]: JSON.stringify(data, null, 2) };
}
