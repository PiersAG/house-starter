// The load test's gate and report (app-business-core #356; plan in config/load-test.ts).
//
//   npx tsx scripts/load/gate.ts --check-target http://127.0.0.1:3100
//   npx tsx scripts/load/gate.ts --dir load-results --k6-exit 0
//
// Reads k6's summary and the app's processor samples, writes report.md (the job's
// summary and the PR's comment) and exits 1 unless every line of the plan's pass bar
// held. Fails closed: no summary, a k6 crash, or a run that did not reach the plan's
// users, flood or CORS checks is a failure, not a pass. Matt Murphy #3 also asks to
// "identify the limiting component", so the report names the slowest step and says
// whether the app's processor was the ceiling.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertLoadTarget, LOAD_TEST, slug } from "../../config/load-test";

type MetricValues = Record<string, number | undefined>;
export type K6Summary = { metrics?: Record<string, { values?: MetricValues } | undefined> };
export type ServerSample = { cpuPercent: number; memoryKb: number };
export type Line = { what: string; bar: string; measured: string; ok: boolean };
export type Verdict = {
  passed: boolean;
  lines: Line[];
  steps: { name: string; p95: number; count: number }[];
  limiting: string;
  serverPeak: ServerSample | null;
};

/** At or above this share of one core, the single app process was the ceiling. */
export const PROCESSOR_BOUND_PERCENT = 90;

const value = (s: K6Summary, metric: string, stat: string): number | undefined => s.metrics?.[metric]?.values?.[stat];
const count = (s: K6Summary, metric: string): number => value(s, metric, "count") ?? 0;
const ms = (n: number | undefined): string => (n === undefined ? "not measured" : `${Math.round(n)} ms`);
const percent = (n: number | undefined): string => (n === undefined ? "not measured" : `${(n * 100).toFixed(2)}%`);

export function parseSamples(text: string): ServerSample[] {
  return text
    .split("\n")
    .map((row) => row.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 2 && row.every(Number.isFinite))
    .map(([cpuPercent, memoryKb]) => ({ cpuPercent, memoryKb }));
}

/** The whole verdict, from k6's summary and the app's samples. */
export function evaluate(summary: K6Summary | null, samples: ServerSample[], k6Exit: number): Verdict {
  const s = summary ?? {};
  const pass = LOAD_TEST.pass;
  const lines: Line[] = [];
  const line = (what: string, bar: string, measured: string, ok: boolean) => lines.push({ what, bar, measured, ok });

  line("k6 finished", "exit code 0 and a summary", summary ? `exit code ${k6Exit}` : `exit code ${k6Exit}, no summary`, k6Exit === 0 && summary !== null);

  const up = count(s, "users_signed_up");
  const inn = count(s, "users_signed_in");
  const peak = value(s, "vus", "max") ?? 0;
  line("Users at the same time", `at least ${LOAD_TEST.concurrentUsers}`, String(peak), peak >= LOAD_TEST.concurrentUsers);
  line("Users signed up and signed in", `all ${LOAD_TEST.concurrentUsers}`, `${up} signed up, ${inn} signed in`, up >= LOAD_TEST.concurrentUsers && inn >= LOAD_TEST.concurrentUsers);

  const expectedNew = Math.floor(LOAD_TEST.holdSeconds / LOAD_TEST.newSignUpEverySeconds);
  const fresh = count(s, "newcomers_signed_up");
  line("New sign-ups at full load", `at least ${Math.floor(expectedNew * 0.9)} of ${expectedNew}`, String(fresh), fresh >= Math.floor(expectedNew * 0.9));

  const errorRate = value(s, "journey_errors", "rate");
  line("Requests with a wrong answer", `under ${percent(pass.maxErrorRate)}`, percent(errorRate), errorRate !== undefined && errorRate < pass.maxErrorRate);

  const p95 = value(s, "journey_duration", "p(95)");
  line("95% of requests answered within", `${pass.p95Milliseconds} ms`, ms(p95), p95 !== undefined && p95 <= pass.p95Milliseconds);

  const serverErrors = count(s, "journey_server_errors");
  line("Server errors in the journey", String(pass.maxServerErrors), String(serverErrors), serverErrors <= pass.maxServerErrors);

  const flood = LOAD_TEST.flood;
  const expectedFlood = flood.requestsPerSecondPerPath * flood.paths.length * flood.seconds;
  const sent = count(s, "flood_requests");
  line("Flood requests sent", `at least ${Math.floor(expectedFlood * 0.9)}`, String(sent), sent >= Math.floor(expectedFlood * 0.9));
  for (const path of flood.paths) {
    const refused = count(s, `flood_refused_${slug(path)}`);
    line(`Flood on ${path} refused with ${flood.expect.refusedWith}`, "at least one", String(refused), refused > 0);
  }
  const noRetry = count(s, "flood_refused_without_retry_after");
  line("Refusals missing Retry-After", "0", String(noRetry), noRetry === 0);
  const floodErrors = count(s, "flood_server_errors");
  line("Server errors in the flood", String(flood.expect.maxServerErrors), String(floodErrors), floodErrors <= flood.expect.maxServerErrors);
  const odd = count(s, "flood_unexpected_answers");
  line("Other answers to the flood", "0", String(odd), odd === 0);

  const corsSent = count(s, "cors_requests");
  const corsBad = count(s, "cors_failures");
  line("Another website's requests refused, no CORS header", "every one", `${corsSent - corsBad} of ${corsSent}`, corsSent > 0 && corsBad === 0);

  const steps = LOAD_TEST.journey
    .map((step) => {
      const metric = `step_${slug(step.name)}`;
      return { name: step.name, p95: value(s, metric, "p(95)") ?? 0, count: count(s, metric) };
    })
    .sort((a, b) => b.p95 - a.p95);

  const serverPeak = samples.length
    ? { cpuPercent: Math.max(...samples.map((x) => x.cpuPercent)), memoryKb: Math.max(...samples.map((x) => x.memoryKb)) }
    : null;
  const slowest = steps[0];
  const bound = serverPeak !== null && serverPeak.cpuPercent >= PROCESSOR_BOUND_PERCENT;
  const limiting = !slowest || slowest.count === 0
    ? "Not measured: no journey step was timed."
    : `Slowest step: ${slowest.name} (95% within ${ms(slowest.p95)}). ` +
      (serverPeak === null
        ? "The app's processor use was not recorded."
        : bound
          ? `The app's process reached ${Math.round(serverPeak.cpuPercent)}% of a core, so its processor is the first ceiling.`
          : `The app's process peaked at ${Math.round(serverPeak.cpuPercent)}% of a core, so its processor was not the ceiling.`);

  return { passed: lines.every((l) => l.ok), lines, steps, limiting, serverPeak };
}

/** The report, for the job's summary and the PR's comment. */
export function report(v: Verdict): string {
  const rows = v.lines.map((l) => `| ${l.ok ? "✅" : "❌"} ${l.what} | ${l.bar} | ${l.measured} |`);
  const steps = v.steps.map((s) => `| ${s.name} | ${ms(s.p95)} | ${s.count} |`);
  const memory = v.serverPeak ? `Peak memory: ${Math.round(v.serverPeak.memoryKb / 1024)} MB.` : "";
  return [
    "<!-- load-test-report -->",
    `## Load test: ${v.passed ? "passed" : "FAILED"}`,
    "",
    `${LOAD_TEST.concurrentUsers} users at once on a local production build (k6, on this runner), with sign-up, a rate-limit flood and another website's requests.`,
    "",
    "| Check | Bar | Measured |",
    "|---|---|---|",
    ...rows,
    "",
    `**Limiting component.** ${v.limiting} ${memory}`.trim(),
    "",
    "| Step, slowest first | 95% within | Requests |",
    "|---|---|---|",
    ...steps,
    "",
  ].join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const target = arg("--check-target");
  if (target) {
    assertLoadTarget(target);
    return;
  }
  const dir = arg("--dir") ?? "load-results";
  const k6Exit = Number(arg("--k6-exit") ?? "1");
  const summaryPath = join(dir, "summary.json");
  const samplesPath = join(dir, "server-samples.txt");
  let summary: K6Summary | null = null;
  try {
    if (existsSync(summaryPath)) summary = JSON.parse(readFileSync(summaryPath, "utf8")) as K6Summary;
  } catch {
    summary = null; // an unreadable summary is no summary: it fails below
  }
  const samples = existsSync(samplesPath) ? parseSamples(readFileSync(samplesPath, "utf8")) : [];
  const verdict = evaluate(summary, samples, k6Exit);
  const text = report(verdict);
  writeFileSync(join(dir, "report.md"), text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
  if (!verdict.passed) {
    for (const l of verdict.lines.filter((x) => !x.ok)) {
      console.log(`::error::Load test: ${l.what}: wanted ${l.bar}, measured ${l.measured}`);
    }
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("gate.ts")) main();
