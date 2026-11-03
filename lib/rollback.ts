// One-command rollback of a bad production deploy, timed (app-business-core
// issues 793 and 345; Matt Murphy #287: "roll back to the last working version
// in 30 seconds with one command"; #307: "click under 60 seconds full rollback";
// #143: "rollback to the last known good deploy … just one button previous
// version immediately").
//
// It uses the host's own instant rollback (Vercel points the production address
// back at an earlier, already-built deployment — nothing is rebuilt), so the
// database is NOT rolled back with it. That is safe only because every release
// is expand-only (lib/migrations/changes.ts), so the previous version can read
// the current database.
//
// DONE MEANS SEEN. The rollback is not counted when the host accepts the
// request, but when the live health page (/api/health) reports the previous
// deployment's commit — the effect, observed on the real address. The time from
// the command to that moment is measured against config/recovery.ts.
//
// The Vercel endpoints below are from Vercel's REST API reference
// (vercel.com/docs/rest-api), not re-checked live when written; the first timed
// drill on a deployed app (issue 793) confirms them. If one has moved, the
// dashboard path in docs/recovery.md is the fallback: Deployments → the previous
// production deployment → ⋯ → Instant Rollback.

import { recoveryTargets, type RecoveryTargets } from "@/config/recovery";

export const VERCEL_API = "https://api.vercel.com";

export interface Deployment {
  id: string;
  url: string;
  created: number;
  commit: string | null;
}

export interface RollbackOptions {
  token: string;
  projectId: string;
  teamId?: string;
  /** The production address, e.g. https://app.example.com. */
  appUrl: string;
  /** Roll back to this deployment instead of the one before the current one. */
  toDeploymentId?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Give up waiting for the effect after this long. */
  timeoutMs?: number;
  targets?: RecoveryTargets;
}

export interface RollbackReport {
  ok: boolean;
  dry_run: boolean;
  from: Deployment | null;
  to: Deployment | null;
  /** Command start to the live address serving `to`. */
  seconds: number | null;
  target_seconds: number;
  aim_seconds: number;
  within_target: boolean;
  within_aim: boolean;
  problems: string[];
}

type Raw = {
  uid?: string;
  id?: string;
  url?: string;
  created?: number;
  createdAt?: number;
  meta?: { githubCommitSha?: string };
};

function toDeployment(d: Raw): Deployment {
  return {
    id: String(d.uid ?? d.id ?? ""),
    url: String(d.url ?? ""),
    created: Number(d.created ?? d.createdAt ?? 0),
    commit: d.meta?.githubCommitSha ?? null,
  };
}

export async function rollback(opts: RollbackOptions): Promise<RollbackReport> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const targets = opts.targets ?? recoveryTargets;
  const team = opts.teamId ? `teamId=${encodeURIComponent(opts.teamId)}` : "";
  const headers = { Authorization: `Bearer ${opts.token}` };
  const t0 = now();
  const report: RollbackReport = {
    ok: false,
    dry_run: opts.dryRun === true,
    from: null,
    to: null,
    seconds: null,
    target_seconds: targets.rollbackSeconds,
    aim_seconds: targets.rollbackAimSeconds,
    within_target: false,
    within_aim: false,
    problems: [],
  };

  // What the live address serves now: its commit, from the health page.
  async function servedCommit(): Promise<string | null> {
    try {
      const r = await f(`${opts.appUrl.replace(/\/$/, "")}/api/health`, { cache: "no-store" });
      if (!r.ok) return null;
      return ((await r.json()) as { commit?: string | null }).commit ?? null;
    } catch {
      return null;
    }
  }

  const listUrl =
    `${VERCEL_API}/v6/deployments?projectId=${encodeURIComponent(opts.projectId)}` +
    `&target=production&state=READY&limit=20${team ? `&${team}` : ""}`;
  const list = await f(listUrl, { headers });
  if (!list.ok) {
    report.problems.push(`the host refused the deployment list (HTTP ${list.status})`);
    return report;
  }
  const deployments = (((await list.json()) as { deployments?: Raw[] }).deployments ?? [])
    .map(toDeployment)
    .filter((d) => d.id)
    .sort((a, b) => b.created - a.created);

  const live = await servedCommit();
  const current = deployments.find((d) => d.commit && d.commit === live) ?? deployments[0] ?? null;
  report.from = current;
  const to = opts.toDeploymentId
    ? deployments.find((d) => d.id === opts.toDeploymentId)
    : deployments.find((d) => current && d.created < current.created);
  if (!to) {
    report.problems.push(
      opts.toDeploymentId
        ? `deployment ${opts.toDeploymentId} is not a ready production deployment of this project`
        : "there is no earlier ready production deployment to go back to",
    );
    return report;
  }
  report.to = to;
  if (!to.commit) report.problems.push("the earlier deployment has no recorded commit, so its arrival cannot be seen");
  if (opts.dryRun || report.problems.length) {
    report.ok = opts.dryRun === true && report.problems.length === 0;
    return report;
  }

  const go = await f(
    `${VERCEL_API}/v9/projects/${encodeURIComponent(opts.projectId)}/rollback/${encodeURIComponent(to.id)}${team ? `?${team}` : ""}`,
    { method: "POST", headers },
  );
  if (!go.ok) {
    report.problems.push(`the host refused the rollback (HTTP ${go.status}) — use the dashboard path in docs/recovery.md`);
    return report;
  }

  const deadline = t0 + (opts.timeoutMs ?? 5 * 60_000);
  while (now() < deadline) {
    if ((await servedCommit()) === to.commit) {
      report.seconds = Math.round((now() - t0) / 100) / 10;
      report.within_target = report.seconds <= targets.rollbackSeconds;
      report.within_aim = report.seconds <= targets.rollbackAimSeconds;
      if (!report.within_target) {
        report.problems.push(`the rollback took ${report.seconds}s; the target is ${targets.rollbackSeconds}s`);
      }
      report.ok = report.problems.length === 0;
      return report;
    }
    await sleep(1000);
  }
  report.problems.push("the live address did not start serving the earlier version before the time limit");
  return report;
}
