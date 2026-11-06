// The load test's gate and how it runs (scripts/load/; app-business-core #356).
// A gate that cannot fail proves nothing, so every line of the pass bar is broken here
// in turn, from a passing k6 summary. The rest holds the runner to the brief: k6 pinned
// and free, a local target only, in "All CI checks passed", result shown on the PR.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, parseSamples, PROCESSOR_BOUND_PERCENT, report, type K6Summary } from "@/scripts/load/gate";
import { LOAD_TEST, slug } from "@/config/load-test";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function passing(): NonNullable<K6Summary["metrics"]> {
  const metrics: NonNullable<K6Summary["metrics"]> = {
    vus: { values: { max: 130 } },
    users_signed_up: { values: { count: 100 } },
    users_signed_in: { values: { count: 100 } },
    newcomers_signed_up: { values: { count: 90 } },
    journey_errors: { values: { rate: 0.001 } },
    journey_duration: { values: { "p(95)": 900 } },
    journey_server_errors: { values: { count: 0 } },
    flood_requests: { values: { count: 2000 } },
    flood_refused_api_auth_signup: { values: { count: 990 } },
    flood_refused_api_health: { values: { count: 400 } },
    cors_requests: { values: { count: 80 } },
  };
  LOAD_TEST.journey.forEach((s, i) => {
    metrics[`step_${slug(s.name)}`] = { values: { "p(95)": 100 + i * 10, count: 50 } };
  });
  return metrics;
}

const run = (change: (m: NonNullable<K6Summary["metrics"]>) => void = () => {}, k6Exit = 0) => {
  const metrics = passing();
  change(metrics);
  return evaluate({ metrics }, [{ cpuPercent: 60, memoryKb: 512_000 }], k6Exit);
};
const failed = (v: ReturnType<typeof evaluate>) => v.lines.filter((l) => !l.ok).map((l) => l.what);

describe("load-test gate", () => {
  it("passes a run that met every line of the plan", () => {
    const v = run();
    expect(failed(v)).toEqual([]);
    expect(v.passed).toBe(true);
  });

  it("fails closed: no summary, or k6 crashing, is never a pass", () => {
    expect(evaluate(null, [], 0).passed).toBe(false);
    expect(evaluate({}, [], 0).passed).toBe(false);
    expect(run(() => {}, 107).passed).toBe(false);
  });

  it.each([
    ["too few users at once", (m) => { m.vus = { values: { max: 99 } }; }, "Users at the same time"],
    ["a user who could not sign up", (m) => { m.users_signed_up = { values: { count: 99 } }; }, "Users signed up and signed in"],
    ["a user who could not sign in", (m) => { m.users_signed_in = { values: { count: 99 } }; }, "Users signed up and signed in"],
    ["sign-ups failing at full load", (m) => { m.newcomers_signed_up = { values: { count: 10 } }; }, "New sign-ups at full load"],
    ["1% of answers wrong", (m) => { m.journey_errors = { values: { rate: 0.01 } }; }, "Requests with a wrong answer"],
    ["no error rate at all", (m) => { delete m.journey_errors; }, "Requests with a wrong answer"],
    ["slow answers", (m) => { m.journey_duration = { values: { "p(95)": 1501 } }; }, "95% of requests answered within"],
    ["one server error", (m) => { m.journey_server_errors = { values: { count: 1 } }; }, "Server errors in the journey"],
    ["a flood that was not sent", (m) => { m.flood_requests = { values: { count: 100 } }; }, "Flood requests sent"],
    ["sign-up flood not refused", (m) => { delete m.flood_refused_api_auth_signup; }, "Flood on /api/auth/signup refused with 429"],
    ["health flood not refused", (m) => { delete m.flood_refused_api_health; }, "Flood on /api/health refused with 429"],
    ["a refusal with no Retry-After", (m) => { m.flood_refused_without_retry_after = { values: { count: 1 } }; }, "Refusals missing Retry-After"],
    ["a server error in the flood", (m) => { m.flood_server_errors = { values: { count: 1 } }; }, "Server errors in the flood"],
    ["an odd answer to the flood", (m) => { m.flood_unexpected_answers = { values: { count: 1 } }; }, "Other answers to the flood"],
    ["another website let through", (m) => { m.cors_failures = { values: { count: 1 } }; }, "Another website's requests refused, no CORS header"],
    ["no CORS check run", (m) => { delete m.cors_requests; }, "Another website's requests refused, no CORS header"],
  ] satisfies [string, (m: NonNullable<K6Summary["metrics"]>) => void, string][])("fails on %s", (_name, change, line) => {
    const v = run(change);
    expect(v.passed).toBe(false);
    expect(failed(v)).toContain(line);
  });

  it("names the limiting component: the slowest step, and whether the processor was the ceiling", () => {
    const metrics = passing();
    metrics.step_sign_up = { values: { "p(95)": 1400, count: 190 } };
    const calm = evaluate({ metrics }, [{ cpuPercent: 60, memoryKb: 1 }], 0);
    expect(calm.steps[0].name).toBe("sign up");
    expect(calm.limiting).toContain("Slowest step: sign up");
    expect(calm.limiting).toContain("was not the ceiling");
    const bound = evaluate({ metrics }, parseSamples(`50 1000\n${PROCESSOR_BOUND_PERCENT} 2000\n`), 0);
    expect(bound.limiting).toContain("first ceiling");
    expect(bound.serverPeak).toEqual({ cpuPercent: PROCESSOR_BOUND_PERCENT, memoryKb: 2000 });
    expect(evaluate({}, [], 0).limiting).toContain("Not measured");
  });

  it("reports in plain words, with a marker and every line", () => {
    const text = report(run((m) => { m.journey_server_errors = { values: { count: 2 } }; }));
    expect(text).toContain("## Load test: FAILED");
    expect(text).toContain("❌ Server errors in the journey");
    expect(text).toContain("**Limiting component.**");
    expect(report(run())).toContain("## Load test: passed");
  });

  it("reads the processor samples and skips what is not a sample", () => {
    expect(parseSamples("12.5 1000\n\nnot a sample\n7 2000\n")).toEqual([
      { cpuPercent: 12.5, memoryKb: 1000 },
      { cpuPercent: 7, memoryKb: 2000 },
    ]);
  });
});

describe("how the load test runs", () => {
  const ci = read(".github/workflows/ci.yml");
  const job = ci.slice(ci.indexOf("\n  load-test:\n"), ci.indexOf("\n  # THE CORRECTNESS GATE"));
  const runner = read("scripts/load/run.sh");
  const install = read("scripts/load/install-k6.sh");
  const k6Script = read("scripts/load/journey.js");

  it("uses k6, pinned by version and checksum, from its open-source releases", () => {
    expect(install).toMatch(/^K6_VERSION="\d+\.\d+\.\d+"$/m);
    expect(install).toMatch(/^K6_SHA256="[0-9a-f]{64}"$/m);
    expect(install).toContain("https://github.com/grafana/k6/releases/download/");
    expect(install).toContain("sha256sum --check --strict");
  });

  it("never uses k6's paid cloud service", () => {
    for (const text of [runner, install, k6Script, job]) {
      expect(text).not.toMatch(/k6 cloud|K6_CLOUD|--out cloud|grafana\.net/);
    }
  });

  it("checks the target before anything starts, and twice over", () => {
    expect(runner.indexOf("--check-target")).toBeLessThan(runner.indexOf("next start"));
    expect(runner).toContain("VERCEL_ENV");
    expect(runner).toContain("-H 127.0.0.1");
    expect(k6Script).toMatch(/127\\.0\\.0\\.1\|localhost/);
  });

  it("runs on GitHub's runners on every pull request, inside All CI checks passed", () => {
    expect(job).toMatch(/runs-on: ubuntu-/);
    expect(job).toContain("bash scripts/load/run.sh");
    expect(ci).toMatch(/needs: \[[^\]]*\bload-test\b/);
  });

  it("shows the result on the pull request, without the app ever holding the token", () => {
    expect(job).toContain("gh pr comment");
    expect(job).toContain("persist-credentials: false");
    const token = job.indexOf("GH_TOKEN:");
    expect(token).toBeGreaterThan(job.indexOf("bash scripts/load/run.sh"));
    expect(job.match(/GH_TOKEN:/g)).toHaveLength(1);
    expect(read("scripts/load/gate.ts")).toContain("GITHUB_STEP_SUMMARY");
  });

  it("sets no real value: every key in the job is a labelled dummy", () => {
    const keys = [...job.matchAll(/^ {6}([A-Z_]*(?:SECRET|KEY)[A-Z_]*): (.+)$/gm)];
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const [, name, value] of keys) expect(value, name).toMatch(/load-test-only-dummy/);
  });
});
