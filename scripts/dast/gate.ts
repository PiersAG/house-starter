// The active scan's gate (app-business-core issue 533: "block on High").
//
//   npx tsx scripts/dast/gate.ts --dir dast-results --base http://127.0.0.1:3000 [--server-log dast-server.log]
//                                [--expect-high /dashboard/canary]   (self-test: pass only if the seeded flaw is caught)
//
// FAIL-CLOSED, like the baseline scan's gate in the factory's security-scan
// workflow: a missing or unreadable report, a report with no scanned site, or a
// ZAP log that never says the ACTIVE scan finished is a failure, not a clean
// result. Then:
//
//   BLOCKS   any High finding (ZAP riskcode 3) — the ticket's bar.
//   BLOCKS   a scan that ran signed out: after the scan, the scan account's
//            session must still open a signed-in page (a scan that lost its
//            session part-way would pass having attacked only the public pages).
//   REPORTS  Medium and Low findings, and how many of the scan's requests the
//            app's own rate limits and attack filter refused (read from the
//            server's security log), so a reader can see what reached the code.
//
// Writes a summary to $GITHUB_STEP_SUMMARY when set. Exit 0 = passed.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertLocalTarget, SCAN_ADDRESS, SESSION_COOKIE, SIGNED_IN_PROBE, type ScanSession } from "./session";

export type ZapAlert = {
  pluginid?: string;
  alert?: string;
  name?: string;
  riskcode?: string | number;
  instances?: { uri?: string; method?: string; param?: string }[];
};
export type ZapReport = { site?: { "@name"?: string; alerts?: ZapAlert[] }[] };
export type Finding = { plugin: string; risk: number; name: string; where: string; count: number };

const RISK = ["Informational", "Low", "Medium", "High"];
/** The log line the Automation Framework prints when the active scan job ends. */
export const ACTIVE_SCAN_DONE = /Job activeScan finished/;

export function findings(report: ZapReport): Finding[] {
  const out: Finding[] = [];
  for (const site of report.site ?? []) {
    for (const a of site.alerts ?? []) {
      const instances = a.instances ?? [];
      const first = instances[0];
      out.push({
        plugin: String(a.pluginid ?? "?"),
        risk: Number(a.riskcode ?? 0) || 0,
        name: (a.alert ?? a.name ?? "").trim(),
        where: first ? `${first.method ?? "GET"} ${first.uri ?? ""}${first.param ? ` (${first.param})` : ""}` : "",
        count: instances.length,
      });
    }
  }
  return out.sort((x, y) => y.risk - x.risk || x.plugin.localeCompare(y.plugin));
}

/**
 * Security-log events (lib/security-log.ts) that mean the app refused a scan
 * request, or ended or refused its session, rather than the code answering it.
 */
export const REFUSAL_EVENT =
  /^(route_rate_limited|abuse_throttled|abuse_banned|attack_request_refused|session_token_rejected|session_ended|access_denied)$/;

/** Requests the app itself refused, from the server's JSON security log lines. */
export function refusals(serverLog: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of serverLog.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = (JSON.parse(line) as { event?: string }).event;
      if (event && REFUSAL_EVENT.test(event)) counts[event] = (counts[event] ?? 0) + 1;
    } catch {
      /* not a log event */
    }
  }
  return counts;
}

export type Verdict = { passed: boolean; problems: string[]; findings: Finding[] };

export function judge(input: {
  report: ZapReport | null;
  zapLog: string;
  stillSignedIn: boolean;
  /**
   * SELF-TEST (active-scan-selftest.yml): the run passes only when a High
   * finding was raised at a path containing this text — the seeded flaw caught.
   */
  expectHigh?: string;
}): Verdict {
  const problems: string[] = [];
  if (!input.report) return { passed: false, problems: ["no readable ZAP report: the scan did not complete"], findings: [] };
  if (!(input.report.site ?? []).length) problems.push("the ZAP report names no scanned site: ZAP never reached the app");
  if (!ACTIVE_SCAN_DONE.test(input.zapLog)) problems.push("the ZAP log never says the active scan finished");
  if (!input.stillSignedIn) {
    problems.push(`after the scan the scan account's session no longer opens ${SIGNED_IN_PROBE}: the scan may have run signed out`);
  }
  const all = findings(input.report);
  const high = all.filter((x) => x.risk >= 3);
  if (input.expectHigh !== undefined) {
    if (!high.some((f) => f.where.includes(input.expectHigh as string))) {
      problems.push(`self-test: no High finding at ${input.expectHigh} — the seeded flaw was NOT caught`);
    }
    return { passed: problems.length === 0, problems, findings: all };
  }
  for (const f of high) problems.push(`High: [ZAP ${f.plugin}] ${f.name} — ${f.where}`);
  return { passed: problems.length === 0, problems, findings: all };
}

export function summary(verdict: Verdict, refused: Record<string, number>): string {
  const lines = ["## Active scan (OWASP ZAP, signed in)", ""];
  lines.push(
    "A real instance of this app, built and served on the runner, crawled and ATTACKED (injection, cross-site scripting " +
      "and the rest of ZAP's active rules) while signed in as a throwaway test account, with every API route fed in. " +
      "Blocks on any High finding (app-business-core issue 533).",
    "",
  );
  const by = (risk: number) => verdict.findings.filter((f) => f.risk === risk);
  lines.push(`- **High (blocks): ${by(3).length}**`, `- Medium: ${by(2).length}`, `- Low: ${by(1).length}`, `- Informational: ${by(0).length}`);
  const refusedTotal = Object.values(refused).reduce((a, b) => a + b, 0);
  lines.push(
    `- Requests the app's own rate limits and attack filter refused: ${refusedTotal}` +
      (refusedTotal ? ` (${Object.entries(refused).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""),
    "",
  );
  const shown = verdict.findings.filter((f) => f.risk >= 1);
  if (shown.length) {
    lines.push("| Risk | Plugin | Finding | First seen at | Instances |", "|---|---|---|---|---|");
    for (const f of shown.slice(0, 60)) {
      const cell = (t: string) => t.replace(/\|/g, "\\|").slice(0, 120);
      lines.push(`| ${RISK[f.risk] ?? f.risk} | \`${f.plugin}\` | ${cell(f.name)} | ${cell(f.where)} | ${f.count} |`);
    }
    lines.push("");
  }
  lines.push(verdict.passed ? "**Result: passed.**" : "**Result: FAILED.**");
  for (const p of verdict.problems) lines.push(`- ${p}`);
  return lines.join("\n") + "\n";
}

export async function stillSignedIn(base: string, session: ScanSession): Promise<boolean> {
  const res = await fetch(`${assertLocalTarget(base).origin}${SIGNED_IN_PROBE}`, {
    redirect: "manual",
    headers: { "x-forwarded-for": SCAN_ADDRESS, cookie: `${SESSION_COOKIE}=${session.cookie}` },
  });
  return res.status === 200;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function readOr(path: string | undefined, fallback = ""): string {
  return path && existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

async function main(): Promise<void> {
  const dir = arg("--dir", "dast-results") as string;
  const base = arg("--base", "http://127.0.0.1:3000") as string;
  let report: ZapReport | null = null;
  try {
    report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as ZapReport;
  } catch {
    report = null;
  }
  const session = JSON.parse(readOr(join(dir, "session.json"), "{}")) as ScanSession;
  const signedIn = session.cookie ? await stillSignedIn(base, session).catch(() => false) : false;
  const verdict = judge({
    report,
    zapLog: readOr(join(dir, "zap.log")),
    stillSignedIn: signedIn,
    expectHigh: arg("--expect-high"),
  });
  const text = summary(verdict, refusals(readOr(arg("--server-log"))));
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  for (const p of verdict.problems) console.error(`::error::Active scan: ${p}`);
  process.exit(verdict.passed ? 0 : 1);
}

if (process.argv[1]?.endsWith("gate.ts")) {
  main().catch((error: unknown) => {
    console.error(`::error::Active scan gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
