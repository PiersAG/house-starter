// The timed restore drill (app-business-core issues 345, 472, 752; Matt Murphy
// #88: "schedule a quarterly restoration test … a clean environment restore into
// it verify the data is intact and the application runs document the steps";
// #182: "restore to a test environment once a month minimum"; #200: "recovery
// time is a business metric").
//
// One drill = the steps docs/recovery.md gives a person at 3am, run by machine
// and timed: fetch the newest export, restore it into a clean environment,
// verify it, put deletions back (after-restore steps), start the app on it and
// check that it serves. The report says how long recovery took against the RTO
// target and how old the restored data was against the RPO target, and fails
// the drill when either is missed — the targets are the CEO's
// (config/recovery.ts).

import "server-only";

import { recoveryTargets, type RecoveryTargets } from "@/config/recovery";
import { restoreAll, type RestoreResult } from "@/lib/backup/restore";

export interface DrillStep {
  name: string;
  seconds: number;
  ok: boolean;
  detail?: string;
}

export interface DrillReport {
  app: string;
  started_at: string;
  finished_at: string;
  export_created_at: string;
  steps: DrillStep[];
  /** Start of the drill to the app serving on the restored data. */
  recovery_minutes: number;
  /** How old the newest restored data was when the drill started. */
  data_age_minutes: number;
  targets: { rto_minutes: number; rpo_minutes: number };
  within_rto: boolean;
  within_rpo: boolean;
  databases: number;
  rows: number;
  ok: boolean;
  problems: string[];
}

export interface DrillOptions {
  app: string;
  /** Fetch the newest export into a local folder; returns that folder. In the
   *  job this downloads from the locked bucket; in tests it is a local folder. */
  fetchExport: () => Promise<string>;
  targetDir: string;
  /** Steps that must run on the restored copy before the app reopens — for one,
   *  replaying the deletion record so erased accounts stay erased. */
  afterRestore?: { name: string; run: (restored: RestoreResult) => Promise<void> }[];
  /** Start the app against the restored catalog and check it serves. */
  boot?: (restored: RestoreResult) => Promise<{ ok: boolean; detail?: string }>;
  targets?: RecoveryTargets;
  now?: () => number;
}

const minutes = (ms: number) => Math.round((ms / 60_000) * 100) / 100;

export async function runDrill(opts: DrillOptions): Promise<DrillReport> {
  const now = opts.now ?? Date.now;
  const targets = opts.targets ?? recoveryTargets;
  const t0 = now();
  const steps: DrillStep[] = [];
  const problems: string[] = [];

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const s = now();
    try {
      const v = await fn();
      steps.push({ name, seconds: Math.round((now() - s) / 100) / 10, ok: true });
      return v;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ name, seconds: Math.round((now() - s) / 100) / 10, ok: false, detail });
      problems.push(`${name}: ${detail}`);
      return undefined;
    }
  }

  const src = await step("fetch the newest export", opts.fetchExport);
  let restored: RestoreResult | undefined;
  if (src) {
    restored = await step("restore into a clean environment and verify", () =>
      restoreAll({ srcDir: src, targetDir: opts.targetDir, repointTenants: true }),
    );
    if (restored && !restored.ok) {
      steps[steps.length - 1].ok = false;
      problems.push(...restored.problems);
    }
  }
  if (restored?.ok) {
    for (const a of opts.afterRestore ?? []) {
      await step(a.name, () => a.run(restored!));
    }
    if (opts.boot) {
      const booted = await step("start the app on the restored data", () => opts.boot!(restored!));
      if (booted && !booted.ok) {
        steps[steps.length - 1].ok = false;
        steps[steps.length - 1].detail = booted.detail;
        problems.push(`the app did not serve on the restored data${booted.detail ? `: ${booted.detail}` : ""}`);
      }
    } else {
      problems.push("the drill did not start the app, so 'the application runs' was not checked");
    }
  }

  const end = now();
  const created = restored?.manifest.created_at ?? new Date(0).toISOString();
  const recovery = minutes(end - t0);
  const age = minutes(t0 - Date.parse(created));
  const withinRto = recovery <= targets.rtoMinutes;
  const withinRpo = restored !== undefined && age <= targets.rpoProviderLostMinutes;
  if (!withinRto) problems.push(`recovery took ${recovery} minutes; the target is ${targets.rtoMinutes}`);
  if (restored && !withinRpo) {
    problems.push(`the newest export was ${age} minutes old; the target is ${targets.rpoProviderLostMinutes}`);
  }

  const rows = (restored?.manifest.databases ?? []).reduce(
    (n, d) => n + Object.values(d.rows).reduce((a, b) => a + b, 0),
    0,
  );
  return {
    app: opts.app,
    started_at: new Date(t0).toISOString(),
    finished_at: new Date(end).toISOString(),
    export_created_at: created,
    steps,
    recovery_minutes: recovery,
    data_age_minutes: age,
    targets: { rto_minutes: targets.rtoMinutes, rpo_minutes: targets.rpoProviderLostMinutes },
    within_rto: withinRto,
    within_rpo: withinRpo,
    databases: restored?.databases.length ?? 0,
    rows,
    ok: problems.length === 0 && steps.every((s) => s.ok),
    problems,
  };
}
